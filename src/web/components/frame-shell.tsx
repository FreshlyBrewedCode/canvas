import {
  Bot,
  FileCode,
  Globe,
  Maximize,
  Minimize,
  Shapes,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LinkScope } from "@/components/board-link";
import { useFullscreenFrame } from "@/hooks/use-fullscreen";
import { edgeScroll, rowTarget, scrollsFurther } from "@/lib/fullscreen";
import {
  allFrames,
  boardLayout,
  moveFrame,
  raiseFrame,
  readTree,
  removeFrame,
  resizeLayout,
  updateFrame,
  type Frame,
  type FrameType,
} from "@/lib/board";
import { useFrameFocus, useRoom } from "@/lib/room-context";
import { setSnapPreview, type SnapPreview } from "@/lib/snap-preview";
import { cn } from "@/lib/utils";
import {
  applyChanges,
  insertion,
  move,
  resolve,
  snapTarget,
  type Layout,
  type Rect,
  type Target,
} from "../../shared/layout";

/** The kinds of frame, as the toolbar offers them. */
export const FRAME_KINDS = [
  { type: "agent", label: "Agent", Icon: Bot },
  { type: "file", label: "Files", Icon: FileCode },
  { type: "browser", label: "Browser", Icon: Globe },
  { type: "terminal", label: "Terminal", Icon: SquareTerminal },
  { type: "drawing", label: "Drawing", Icon: Shapes },
] as const satisfies ReadonlyArray<{ type: FrameType; label: string; Icon: LucideIcon }>;

const ICONS = Object.fromEntries(FRAME_KINDS.map((k) => [k.type, k.Icon])) as Record<
  FrameType,
  LucideIcon
>;

/**
 * The chrome every frame shares: drag by the header, resize from the corner.
 * Where frames are is the board's tree (ADR 0010), so every move is seen by
 * everyone. A drag is ours until the drop: near another frame it goes into
 * its row or a new row, elsewhere into a cluster of its own, as one change.
 * Resizing sets its column's width and its row's height.
 * Frames hold user data, so they are square (design.md › Shapes).
 *
 * Pressing on a frame claims it (`focus.ts`): its occupant shows in the
 * header, and the frame is ringed in their colour while we follow them.
 *
 * Full screen (`use-fullscreen.ts`) shows the frames of a row as tall as our
 * screen and hides the rest. There a frame only moves along its row, always
 * snapping: it reorders the row, and the view glides after it. Held near the
 * board's left or right side, it scrolls the row along. No resizing.
 */
export function FrameShell({
  frame,
  readOnly,
  status,
  attention = false,
  actions,
  children,
}: {
  frame: Frame;
  readOnly: boolean;
  status?: React.ReactNode;
  /** Something in it waits for the host: outlined in the status colour, over the occupant's ring. */
  attention?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const room = useRoom();
  const Icon = ICONS[frame.type];
  const focus = useFrameFocus(frame.id);
  const ring = attention
    ? "var(--status-ready)"
    : focus.occupant && (focus.mine || focus.following)
      ? focus.occupant.color
      : null;
  // Links in the frame open new frames beside it (ADR 0007).
  const scope = useMemo(() => ({ frame: frame.id }), [frame.id]);
  const fullscreen = useFullscreenFrame(frame);
  /** Where a drag has the frame, from where it is: ours until the drop. */
  const [dragged, setDragged] = useState<{ x: number; y: number } | null>(null);
  const arranging = !readOnly && fullscreen.mode === "off";
  const movable = !readOnly && fullscreen.mode !== "hidden";
  const along =
    fullscreen.mode === "in"
      ? { ...fullscreen.box, show: fullscreen.show, scroll: fullscreen.scroll }
      : null;

  return (
    <section
      data-frame={frame.id}
      data-frame-type={frame.type}
      data-occupant={focus.occupant?.name}
      data-following={focus.following || undefined}
      data-attention={attention || undefined}
      data-dragging={dragged ? "" : undefined}
      data-fullscreen={fullscreen.mode === "off" ? undefined : fullscreen.mode}
      aria-hidden={fullscreen.mode === "hidden" || undefined}
      className="bg-card absolute flex flex-col border shadow-sm data-[fullscreen=hidden]:pointer-events-none data-[fullscreen=hidden]:invisible"
      style={{
        left: frame.x + (dragged?.x ?? 0),
        top: fullscreen.box.y + (dragged?.y ?? 0),
        width: frame.w,
        height: fullscreen.box.h,
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
        disabled={!movable}
        along={along}
        onDrag={setDragged}
        className={cn(
          "bg-muted/40 flex h-9 shrink-0 items-center gap-2 border-b px-2.5",
          movable && "cursor-grab active:cursor-grabbing",
        )}
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
        <button
          type="button"
          data-fullscreen-toggle=""
          title={fullscreen.mode === "in" ? "Leave full screen (Esc)" : "Full screen (F)"}
          className="text-muted-foreground hover:text-foreground rounded-md p-1"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={fullscreen.toggle}
        >
          {fullscreen.mode === "in" ? (
            <Minimize className="size-3.5" />
          ) : (
            <Maximize className="size-3.5" />
          )}
        </button>
        {!readOnly && (
          <button
            type="button"
            title="Remove frame"
            className="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => removeFrame(room.doc, frame.id)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </Drag>
      <LinkScope value={scope}>
        <div className="relative min-h-0 flex-1">{children}</div>
      </LinkScope>
      {arranging && (
        <Drag
          frame={frame}
          mode="resize"
          className="absolute -right-1 -bottom-1 size-4 cursor-nwse-resize"
          disabled={false}
          onDrag={setDragged}
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
  along = null,
  onDrag,
  className,
  children,
}: {
  frame: Frame;
  mode: "move" | "resize";
  disabled: boolean;
  /**
   * In full screen: moves go along the row, which full screen shows at `y`,
   * `h` tall; `scroll` moves the view along it.
   */
  along?: { y: number; h: number; show: () => void; scroll: (dx: number) => void } | null;
  /** Where the frame is dragged to, from where it is; null when it is let go. */
  onDrag: (offset: { x: number; y: number } | null) => void;
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
    moved: boolean;
    /** Along a full-screen row: the pointer's last x, and how far the view scrolled since. */
    cx: number;
    scrolled: number;
    board: HTMLElement | null;
  } | null>(null);
  const frameRequest = useRef(0);
  const scrollRequest = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrollRequest.current), []);

  /** Where a drop at `here` goes: beside the frame within reach, else a cluster of its own there. */
  const target = (here: Rect): Target => {
    const others = allFrames(room.doc).filter((f) => f.id !== frame.id);
    return snapTarget([...others, here], frame.id) ?? clusterSlot(boardLayout(room.doc), here);
  };

  /** Along a full-screen row: in between two of its frames or at an end; null to stay. */
  const targetAlong = (here: Rect): Target | null => {
    const row = allFrames(room.doc).filter((f) => f.row === frame.row);
    return rowTarget(row, here);
  };

  /** What the preview shows for a drop at `target`: a line in between, or where it lands. */
  const preview = (
    here: Rect,
    to: Target | null,
    shown?: { y: number; h: number },
  ): SnapPreview | null => {
    if (!to) return null;
    const others = allFrames(room.doc).filter((f) => f.id !== frame.id);
    const line = "anchor" in to ? insertion([...others, here], to, frame.id) : null;
    if (line) return { kind: "insert", line: shown ? { ...line, ...shown } : line, along: !!shown };
    const tree = readTree(room.doc);
    const lands = resolve(applyChanges(tree, move(tree, frame.id, to))).frames.get(frame.id);
    if (!lands) return null;
    const { x, y, w, h } = lands.frame;
    return { kind: "place", box: { x, y, w, h, ...shown }, along: !!shown };
  };

  /** Where the drag has the frame: the pointer's way, plus the view's along a row. */
  const hereOf = (
    s: NonNullable<typeof start.current>,
    clientX: number,
    clientY: number,
  ): Rect => ({
    id: frame.id,
    x: Math.round(s.x + (clientX - s.px) / s.scale + s.scrolled),
    y: along ? s.y : Math.round(s.y + (clientY - s.py) / s.scale),
    w: s.w,
    h: s.h,
  });

  /** Near the board's side, scroll the row along every animation frame, the frame with it. */
  const edgeScrolling = () => {
    const s = start.current;
    if (!s || !along || !s.board) return;
    const { left, right } = s.board.getBoundingClientRect();
    const v = edgeScroll(s.cx, left, right);
    const here = hereOf(s, s.cx, s.py);
    const row = allFrames(room.doc).filter((f) => f.row === frame.row);
    if (s.moved && scrollsFurther(row, here, v)) {
      along.scroll(v);
      s.scrolled += v;
      const next = hereOf(s, s.cx, s.py);
      onDrag({ x: next.x - s.x, y: 0 });
      setSnapPreview(preview(next, targetAlong(next), along));
    }
    scrollRequest.current = requestAnimationFrame(edgeScrolling);
  };

  const stop = () => {
    start.current = null;
    setSnapPreview(null);
    cancelAnimationFrame(scrollRequest.current);
    cancelAnimationFrame(frameRequest.current);
    onDrag(null);
  };

  const end = (event: React.PointerEvent) => {
    const s = start.current;
    stop();
    if (!s || mode !== "move" || !s.moved) return;
    const here = hereOf(s, event.clientX, event.clientY);
    const to = along ? targetAlong(here) : target(here);
    if (to) moveFrame(room.doc, frame.id, to);
    along?.show();
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
          moved: false,
          cx: event.clientX,
          scrolled: 0,
          board,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        if (along && mode === "move") edgeScrolling();
      }}
      onPointerMove={(event) => {
        const s = start.current;
        if (!s) return;
        s.cx = event.clientX;
        const dx = (event.clientX - s.px) / s.scale;
        const dy = along ? 0 : (event.clientY - s.py) / s.scale;
        if (Math.hypot(dx, dy) > 3) s.moved = true;
        const { clientX, clientY } = event;
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = requestAnimationFrame(() => {
          if (mode === "move") {
            const here = hereOf(s, clientX, clientY);
            onDrag({ x: here.x - s.x, y: here.y - s.y });
            if (!s.moved) return setSnapPreview(null);
            setSnapPreview(
              along ? preview(here, targetAlong(here), along) : preview(here, target(here)),
            );
          } else {
            // Its column's width and its row's height: the rest of the row follows.
            room.doc.transact(() => {
              resizeLayout(room.doc, { column: frame.column, w: s.w + dx });
              resizeLayout(room.doc, { row: frame.row, h: s.h + dy });
            });
          }
        });
      }}
      onPointerUp={end}
      onPointerCancel={stop}
    >
      {children}
    </div>
  );
}

/**
 * A cluster of its own where `here` was dropped: before the first cluster
 * the drop's middle comes before, reading the board left to right, top to
 * bottom.
 */
function clusterSlot(layout: Layout, here: Rect): Target {
  const x = here.x + here.w / 2;
  const y = here.y + here.h / 2;
  const next = layout.clusters.find(
    ({ box }) => y < box.y || (y < box.y + box.h && x < box.x + box.w / 2),
  );
  return { before: next?.id ?? null };
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
