import { Bot, FileCode, Globe, SquareTerminal, X } from "lucide-react";
import { useMemo, useRef } from "react";

import { LinkScope } from "@/components/board-link";
import {
  allFrames,
  applyPatches,
  raiseFrame,
  removeFrame,
  updateFrame,
  type Frame,
} from "@/lib/board";
import { useFrameFocus, useRoom } from "@/lib/room-context";
import { setSnapPreview, type SnapPreview } from "@/lib/snap-preview";
import { cn } from "@/lib/utils";
import {
  insertion,
  lift,
  locate,
  moveFrame,
  resizeInRow,
  snapTarget,
  type Box,
  type Patch,
  type Rect,
} from "../../shared/layout";

const ICONS = { agent: Bot, file: FileCode, browser: Globe, terminal: SquareTerminal };

/**
 * The chrome every frame shares: drag by the header, resize from the corner.
 * Geometry lives in the board doc, so every move is seen by everyone.
 * Near other frames, the layout rules apply (`shared/layout.ts`): a drop
 * snaps into a row or a new row, resizing keeps a row's height. Holding Alt
 * places and sizes a frame freely; holding Shift drags its whole cluster
 * along, as it is.
 * Frames hold user data, so they are square (design.md › Shapes).
 *
 * Pressing on a frame claims it (`focus.ts`): its occupant shows in the
 * header, and the frame is ringed in their colour while we follow them.
 */
export function FrameShell({
  frame,
  readOnly,
  status,
  actions,
  children,
}: {
  frame: Frame;
  readOnly: boolean;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const room = useRoom();
  const Icon = ICONS[frame.type];
  const focus = useFrameFocus(frame.id);
  const ring = focus.occupant && (focus.mine || focus.following) ? focus.occupant.color : null;
  // Links in the frame open new frames beside it (ADR 0007).
  const scope = useMemo(() => ({ frame: frame.id }), [frame.id]);

  return (
    <section
      data-frame={frame.id}
      data-frame-type={frame.type}
      data-occupant={focus.occupant?.name}
      data-following={focus.following || undefined}
      className="bg-card absolute flex flex-col border shadow-sm"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        zIndex: frame.z,
        ...(ring && { borderColor: ring, boxShadow: `0 0 0 1px ${ring}, 0 0 18px -6px ${ring}` }),
      }}
      onPointerDownCapture={() => {
        room.focusFrame(frame.id);
        if (!readOnly) raiseFrame(room.doc, frame.id);
      }}
    >
      <Drag
        frame={frame}
        disabled={readOnly}
        className="bg-muted/40 flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-2.5 active:cursor-grabbing"
        mode="move"
      >
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        {/* As wide as the title, which the hidden copy sizes: the rest of the header drags. */}
        <span className="grid min-w-0 grid-cols-[minmax(0,max-content)] font-mono text-[13px] font-medium">
          <span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre">
            {frame.title}
          </span>
          <input
            aria-label="Frame title"
            className="col-start-1 row-start-1 w-full min-w-[4ch] truncate bg-transparent outline-none"
            value={frame.title}
            readOnly={readOnly}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => updateFrame(room.doc, frame.id, { title: event.target.value })}
          />
        </span>
        <span className="min-w-12 flex-1" />
        {status}
        {focus.occupant && <OccupantBadge frameId={frame.id} focus={focus} />}
        {actions}
        {!readOnly && (
          <button
            type="button"
            title="Remove frame"
            className="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => removeFrame(room.doc, frame.id, lift(allFrames(room.doc), frame.id))}
          >
            <X className="size-3.5" />
          </button>
        )}
      </Drag>
      <LinkScope value={scope}>
        <div className="relative min-h-0 flex-1">{children}</div>
      </LinkScope>
      {!readOnly && (
        <Drag
          frame={frame}
          mode="resize"
          className="absolute -right-1 -bottom-1 size-4 cursor-nwse-resize"
          disabled={false}
        >
          <span className="border-muted-foreground/60 absolute right-1.5 bottom-1.5 size-2 border-r-2 border-b-2" />
        </Drag>
      )}
    </section>
  );
}

function Drag({
  frame,
  mode,
  disabled,
  className,
  children,
}: {
  frame: Frame;
  mode: "move" | "resize";
  disabled: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const room = useRoom();
  const start = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    /** The board when the drag began: where row mates were, for resizing. */
    rects: Rect[];
    /** Its cluster mates where they were when the drag began, for Shift. */
    mates: Array<Pick<Rect, "id" | "x" | "y">>;
    /** Whether the mates were last moved along. */
    carrying: boolean;
    moved: boolean;
  } | null>(null);
  const frameRequest = useRef(0);

  /**
   * The patches a drop at `here` would apply: into a row, or out of the old
   * one. Either way it leaves from where the drag began, so that gap closes.
   */
  const drop = (here: Rect, s: Box): { patches: Patch[]; preview: SnapPreview | null } => {
    const others = allFrames(room.doc).filter((f) => f.id !== frame.id);
    const origin = [...others, { ...here, x: s.x, y: s.y }];
    const rects = [...others, here];
    const target = snapTarget(rects, frame.id);
    if (!target) return { patches: lift(origin, frame.id), preview: null };
    const patches = moveFrame(origin, frame.id, target);
    const line = insertion(rects, target, frame.id);
    const box = { ...here, ...patches.find((p) => p.id === frame.id) };
    return { patches, preview: line ? { kind: "insert", line } : { kind: "place", box } };
  };

  /** With Shift the mates keep their offsets; let go of it and they go back. */
  const carry = (s: NonNullable<typeof start.current>, dx: number, dy: number, shift: boolean) => {
    if (!shift && !s.carrying) return [];
    s.carrying = shift;
    return shift
      ? s.mates.map((m) => ({ id: m.id, x: Math.round(m.x + dx), y: Math.round(m.y + dy) }))
      : s.mates;
  };

  const end = (event: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    setSnapPreview(null);
    if (!s || mode !== "move" || !s.moved) return;
    cancelAnimationFrame(frameRequest.current);
    const dx = (event.clientX - s.px) / s.scale;
    const dy = (event.clientY - s.py) / s.scale;
    const here = { id: frame.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy), w: s.w, h: s.h };
    const mates = carry(s, dx, dy, event.shiftKey);
    const snap = event.shiftKey || event.altKey ? [] : drop(here, s).patches;
    applyPatches(room.doc, [here, ...mates, ...snap]);
  };

  return (
    <div
      className={className}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const board = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-board]");
        const scale = Number(board?.style.getPropertyValue("--board-scale") || 1);
        start.current = {
          px: event.clientX,
          py: event.clientY,
          x: frame.x,
          y: frame.y,
          w: frame.w,
          h: frame.h,
          scale,
          rects: allFrames(room.doc),
          mates: locate(allFrames(room.doc), frame.id)
            .cluster.frames.filter((f) => f.id !== frame.id)
            .map(({ id, x, y }) => ({ id, x, y })),
          carrying: false,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const s = start.current;
        if (!s) return;
        const dx = (event.clientX - s.px) / s.scale;
        const dy = (event.clientY - s.py) / s.scale;
        if (Math.hypot(dx, dy) > 3) s.moved = true;
        const free = event.altKey;
        const shift = event.shiftKey;
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = requestAnimationFrame(() => {
          if (mode === "move") {
            const here = { id: frame.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) };
            applyPatches(room.doc, [here, ...carry(s, dx, dy, shift)]);
            if (free || shift || !s.moved) return setSnapPreview(null);
            setSnapPreview(drop({ ...here, w: s.w, h: s.h }, s).preview);
          } else {
            const size = {
              w: Math.max(280, Math.round(s.w + dx)),
              h: Math.max(180, Math.round(s.h + dy)),
            };
            // Row mates follow from where they were when the resize began.
            if (free) updateFrame(room.doc, frame.id, size);
            else applyPatches(room.doc, resizeInRow(s.rects, frame.id, size));
          }
        });
      }}
      onPointerUp={end}
      onPointerCancel={() => {
        start.current = null;
        setSnapPreview(null);
      }}
    >
      {children}
    </div>
  );
}

/**
 * Who is in the frame. Following them, it just says so; scrolled away,
 * it fades, and a click follows them again.
 */
function OccupantBadge({
  frameId,
  focus,
}: {
  frameId: string;
  focus: ReturnType<typeof useFrameFocus>;
}) {
  const room = useRoom();
  const occupant = focus.occupant!;
  const detached = !focus.mine && !focus.following;
  const who = occupant.kind === "agent" ? `${occupant.name} (agent)` : occupant.name;
  const title = focus.mine
    ? "You are here: others follow your scroll"
    : detached
      ? `${who} is here. Click to follow them again`
      : `${who} is here: you follow their scroll`;
  return (
    <button
      type="button"
      data-occupant-badge=""
      title={title}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold transition-opacity",
        detached && "opacity-45 hover:opacity-100",
        focus.mine && "cursor-default",
      )}
      style={{ backgroundColor: occupant.color, color: "oklch(0.2 0 0)" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => detached && room.follow(frameId)}
    >
      {occupant.kind === "agent" ? <Bot className="size-3" /> : occupant.name.slice(0, 1)}
    </button>
  );
}

export function StatusDot({ status }: { status: "idle" | "running" | "waiting" | "offline" }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "idle" && "bg-status-complete",
          status === "running" && "bg-status-pending animate-pulse",
          status === "waiting" && "bg-status-ready animate-pulse",
          status === "offline" && "bg-status-cancelled",
        )}
      />
      {status}
    </span>
  );
}
