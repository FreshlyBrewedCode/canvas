import { Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { FRAME_KINDS } from "@/components/frame-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BoardViewport } from "@/hooks/use-board-viewport";
import type { FrameType } from "@/lib/board";
import { edgeNear, insertEdges, type Placed } from "@/lib/inserts";
import { cn } from "@/lib/utils";
import { toBoard, type Point } from "@/lib/viewport";
import type { Beside } from "../../shared/layout";

/** Where the menu opens, from the edge: away from the frame it goes beside. */
const MENU = { left: "left", right: "right", above: "top", below: "bottom" } as const;

/** How near a vertical edge the mouse brings up its "+", in px, at any zoom. */
const REACH = 32;

/**
 * A "+" on the vertical edge of a row the mouse is near, one where two frames
 * meet: a menu of frame kinds, and the new frame goes there, the rest of the
 * row making room. Board space, the same size on screen at any zoom. While its
 * menu is open, it stays on its edge wherever the mouse goes.
 */
export function Inserts({
  frames,
  wrapRef,
  viewport,
  onAdd,
}: {
  /** As shown: in full screen, its row's, as tall as they show. */
  frames: ReadonlyArray<Placed>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  viewport: Pick<BoardViewport, "subscribe" | "screen">;
  onAdd: (type: FrameType, target: Beside) => void;
}) {
  const { transform } = useSyncExternalStore(viewport.subscribe, viewport.screen);
  /** The mouse over the board, in its client px: panning and zooming move the board under it. */
  const [pointer, setPointer] = useState<Point | null>(null);
  /** The edge whose menu is open. */
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element;
      // Not over the board's controls, nor while pressed for something else: a pan, a drag, a resize.
      const elsewhere =
        target.closest("[data-hud]:not([data-edge], [data-insert])") ||
        (event.buttons && !target.closest("[data-insert]"));
      if (elsewhere) return setPointer(null);
      const rect = wrap.getBoundingClientRect();
      setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    const onLeave = () => setPointer(null);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, [wrapRef]);

  const edges = useMemo(() => insertEdges(frames), [frames]);
  // Once its frames went, the menu is gone with them.
  const held = open === null ? undefined : edges.find((e) => e.key === open);
  const edge =
    held ?? (pointer && edgeNear(edges, toBoard(transform, pointer), REACH / transform.scale));
  if (!edge) return null;
  const { side } = edge.target;

  return (
    <Popover
      key={edge.key}
      open={edge === held}
      onOpenChange={(next) => setOpen(next ? edge.key : null)}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-hud=""
          data-insert={side}
          data-insert-anchor={edge.target.anchor}
          title="Add a frame here"
          className={cn(
            "bg-card text-muted-foreground hover:text-foreground absolute z-[99998] grid size-6 place-items-center rounded-full border shadow-sm",
            held && "text-foreground",
          )}
          style={{
            left: edge.x,
            top: (edge.top + edge.bottom) / 2,
            transform: "translate(-50%, -50%) scale(calc(1 / var(--board-scale, 1)))",
          }}
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={MENU[side]}
        align="center"
        className="flex w-36 flex-col p-1"
        data-insert-menu=""
      >
        {FRAME_KINDS.map(({ type, label, Icon }) => (
          <button
            key={type}
            type="button"
            className="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
            onClick={() => {
              setOpen(null);
              onAdd(type, edge.target);
            }}
          >
            <Icon className="text-muted-foreground size-3.5" /> {label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
