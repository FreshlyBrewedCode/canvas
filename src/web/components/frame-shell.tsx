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
import { useMemo } from "react";

import { LinkScope } from "@/components/board-link";
import { useFullscreenFrame } from "@/hooks/use-fullscreen";
import { startDrag } from "@/hooks/start-drag";
import {
  allFrames,
  own,
  raiseFrame,
  removeFrame,
  updateFrame,
  type Frame,
  type FrameType,
} from "@/lib/board";
import { useDrag, useGliding } from "@/lib/drag";
import { useFrameFocus, usePeers, useRoom } from "@/lib/room-context";
import { cn } from "@/lib/utils";

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
 * The chrome every frame shares: drag by the header; its edges resize (`edges.tsx`).
 * Where frames are is the board's tree (ADR 0010), so every move is seen by
 * everyone. A drag goes by the pointer and is ours until the drop
 * (`start-drag.ts`): over a frame's left or right edge it goes before or after
 * it in its row, over its top or bottom edge into a new row; elsewhere, or
 * with Alt, into a cluster of its own. Shift drags the whole cluster. While
 * it goes, the others make room (`drag.ts`).
 * Frames hold user data, so they are square (design.md › Shapes).
 *
 * Pressing on a frame claims it (`focus.ts`): its occupant shows in the
 * header, and the frame is ringed in their colour while we follow them.
 *
 * Full screen (`use-fullscreen.ts`) shows the frames of a row as tall as our
 * screen and hides the rest. There a frame only moves along its row: it
 * reorders the row, and the view glides after it. Held near the board's left
 * or right side, it scrolls the row along.
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
  const drag = useDrag();
  const dragged =
    drag?.kind === "frame" ? drag.frame === frame.id : drag?.cluster === frame.cluster;
  const gliding = useGliding() && !dragged;
  const movable = !readOnly && fullscreen.mode !== "hidden";
  const along =
    fullscreen.mode === "in"
      ? { row: frame.row, show: fullscreen.show, scroll: fullscreen.scroll }
      : null;

  return (
    <section
      data-frame={frame.id}
      data-frame-type={frame.type}
      data-occupant={focus.occupant?.name}
      data-following={focus.following || undefined}
      data-attention={attention || undefined}
      data-dragging={dragged || undefined}
      data-fullscreen={fullscreen.mode === "off" ? undefined : fullscreen.mode}
      aria-hidden={fullscreen.mode === "hidden" || undefined}
      className={cn(
        "bg-card absolute flex flex-col border shadow-sm data-[fullscreen=hidden]:pointer-events-none data-[fullscreen=hidden]:invisible",
        gliding && "transition-[left,top,width,height] duration-200 ease-out",
        dragged && "opacity-90 shadow-2xl",
      )}
      style={{
        left: frame.x,
        top: fullscreen.box.y,
        width: frame.w,
        height: fullscreen.box.h,
        zIndex: dragged ? DRAGGED_Z : frame.z,
        ...(ring && { borderColor: ring, boxShadow: `0 0 0 1px ${ring}, 0 0 18px -6px ${ring}` }),
      }}
      onPointerDownCapture={() => {
        room.focusFrame(frame.id);
        if (!readOnly) raiseFrame(room.doc, frame.id);
      }}
    >
      <div
        className={cn(
          "bg-muted/40 flex h-9 shrink-0 items-center gap-2 border-b px-2.5 select-none",
          movable && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          if (!movable) return;
          // Shift: the whole cluster, from its top-left.
          const cluster = event.shiftKey && !along;
          const mates = allFrames(room.doc).filter((f) => f.cluster === frame.cluster);
          startDrag(event, {
            doc: room.doc,
            what: cluster
              ? { kind: "cluster", id: frame.cluster }
              : { kind: "frame", id: frame.id },
            origin: cluster
              ? { x: Math.min(...mates.map((f) => f.x)), y: Math.min(...mates.map((f) => f.y)) }
              : { x: frame.x, y: fullscreen.box.y },
            along,
          });
        }}
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
        <FullscreenPeers frameId={frame.id} />
        {focus.occupant && <OccupantBadge frameId={frame.id} focus={focus} />}
        {actions}
        <button
          type="button"
          data-fullscreen-toggle=""
          title={fullscreen.mode === "in" ? "Leave full screen (F)" : "Full screen (F)"}
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
            title="Remove frame (Shift + X)"
            className="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => own(room.doc, () => removeFrame(room.doc, frame.id))}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <LinkScope value={scope}>
        <div className="relative min-h-0 flex-1">{children}</div>
      </LinkScope>
    </section>
  );
}

/** Who else is in full screen on the frame, each in their colour. */
function FullscreenPeers({ frameId }: { frameId: string }) {
  const here = usePeers().filter((peer) => peer.fullscreen === frameId);
  return here.map(({ user }) => (
    <span
      key={user.peerId}
      data-fullscreen-peer={user.name}
      title={`${user.name} is in full screen here`}
      className="flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold"
      style={{ backgroundColor: user.color, color: "oklch(0.2 0 0)" }}
    >
      <Maximize className="size-3" />
      {user.name}
    </span>
  ));
}

/** Above every frame while dragged. */
const DRAGGED_Z = 99990;

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

/**
 * A frame whose agent, file or terminal is on a runtime this board isn't
 * connected to, or names none at all (ADR 0013, decision 7): nothing of it
 * is opened or sent. It still moves and closes like any frame.
 */
export function UnreachableFrame({
  frame,
  readOnly,
  reach,
}: {
  frame: Frame;
  readOnly: boolean;
  reach: "elsewhere" | "nowhere";
}) {
  const address = frame as { readonly runtime?: unknown; readonly root?: unknown };
  const where = [
    typeof address.runtime === "string" && `runtime ${address.runtime}`,
    typeof address.root === "string" && `root ${address.root}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <FrameShell frame={frame} readOnly={readOnly}>
      <div
        data-frame-body=""
        data-unreachable={reach}
        className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
      >
        <p className="text-sm font-medium">Not reachable</p>
        <p className="text-muted-foreground max-w-80 text-xs">
          {reach === "elsewhere"
            ? `This frame is on ${where || "another runtime"}, which this board isn't connected to.`
            : "This frame names no runtime canvas knows."}
        </p>
      </div>
    </FrameShell>
  );
}
