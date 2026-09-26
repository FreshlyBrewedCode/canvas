import { Bot, FileCode, Globe, SquareTerminal, X } from "lucide-react";
import { useRef } from "react";

import {
  allFrames,
  applyPatches,
  raiseFrame,
  removeFrame,
  updateFrame,
  type Frame,
} from "@/lib/board";
import { useRoom } from "@/lib/room-context";
import { setSnapPreview } from "@/lib/snap-preview";
import { cn } from "@/lib/utils";
import {
  lift,
  moveFrame,
  resizeInRow,
  snapTarget,
  type Patch,
  type Rect,
} from "../../shared/layout";

const ICONS = { agent: Bot, file: FileCode, browser: Globe, terminal: SquareTerminal };

/**
 * The chrome every frame shares: drag by the header, resize from the corner.
 * Geometry lives in the board doc, so every move is seen by everyone.
 * Near other frames, the layout rules apply (`shared/layout.ts`): a drop
 * snaps into a row or a new row, resizing keeps a row's height. Holding Alt
 * places and sizes a frame freely.
 * Frames hold user data, so they are square (design.md › Shapes).
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

  return (
    <section
      data-frame={frame.id}
      data-frame-type={frame.type}
      className="bg-card absolute flex flex-col border shadow-sm"
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, zIndex: frame.z }}
      onPointerDownCapture={() => !readOnly && raiseFrame(room.doc, frame.id)}
    >
      <Drag
        frame={frame}
        disabled={readOnly}
        className="bg-muted/40 flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-2.5 active:cursor-grabbing"
        mode="move"
      >
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <input
          aria-label="Frame title"
          className="min-w-0 flex-1 truncate bg-transparent font-mono text-[13px] font-medium outline-none"
          value={frame.title}
          readOnly={readOnly}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => updateFrame(room.doc, frame.id, { title: event.target.value })}
        />
        {status}
        {actions}
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
      <div className="relative min-h-0 flex-1">{children}</div>
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
    /** The board when the drag began: where row mates were. */
    rects: Rect[];
    moved: boolean;
  } | null>(null);
  const frameRequest = useRef(0);

  /** The patches a drop here would apply: into a row, or out of the old one. */
  const drop = (rects: Rect[], before: Rect[]): { patches: Patch[]; snapped: boolean } => {
    const target = snapTarget(rects, frame.id);
    if (target) return { patches: moveFrame(rects, frame.id, target), snapped: true };
    // Dropped away from everything: the row it left closes up.
    return { patches: lift(before, frame.id), snapped: false };
  };

  const end = (event: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    setSnapPreview(null);
    if (!s || mode !== "move" || !s.moved || event.altKey) return;
    cancelAnimationFrame(frameRequest.current);
    const dx = (event.clientX - s.px) / s.scale;
    const dy = (event.clientY - s.py) / s.scale;
    const here = { id: frame.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy), w: s.w, h: s.h };
    const rects = [...allFrames(room.doc).filter((f) => f.id !== frame.id), here];
    applyPatches(room.doc, [here, ...drop(rects, s.rects).patches]);
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
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = requestAnimationFrame(() => {
          if (mode === "move") {
            const here = { id: frame.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) };
            updateFrame(room.doc, frame.id, here);
            if (free || !s.moved) return setSnapPreview(null);
            const rects = [
              ...allFrames(room.doc).filter((f) => f.id !== frame.id),
              { ...here, w: s.w, h: s.h },
            ];
            const { patches, snapped } = drop(rects, s.rects);
            const landing = patches.find((p) => p.id === frame.id);
            setSnapPreview(snapped && landing ? { x: 0, y: 0, w: s.w, h: s.h, ...landing } : null);
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
