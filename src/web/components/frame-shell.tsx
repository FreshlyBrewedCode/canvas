import { Bot, FileText, Globe, SquareTerminal, X } from "lucide-react";
import { useRef } from "react";

import { raiseFrame, removeFrame, updateFrame, type Frame } from "@/lib/board";
import { useRoom } from "@/lib/room-context";
import { cn } from "@/lib/utils";

const ICONS = { agent: Bot, markdown: FileText, browser: Globe, terminal: SquareTerminal };

/**
 * The chrome every frame shares: drag by the header, resize from the corner.
 * Geometry lives in the board doc, so every move is seen by everyone.
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
  } | null>(null);
  const frameRequest = useRef(0);

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
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const s = start.current;
        if (!s) return;
        const dx = (event.clientX - s.px) / s.scale;
        const dy = (event.clientY - s.py) / s.scale;
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = requestAnimationFrame(() =>
          updateFrame(
            room.doc,
            frame.id,
            mode === "move"
              ? { x: Math.round(s.x + dx), y: Math.round(s.y + dy) }
              : { w: Math.max(280, Math.round(s.w + dx)), h: Math.max(180, Math.round(s.h + dy)) },
          ),
        );
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
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
