/**
 * Dragging a frame by its header, or a cluster by its grip (or a frame with
 * Shift), from pointer down to the drop: where it goes is decided by the
 * pointer on the board laid out without what is dragged (`dropAt`), with Alt a
 * cluster of its own even over frames. A frame hits by its middle's height
 * (`dropPoint`), and the clusters stay where they were (`pin`). Nothing
 * reaches the doc before the drop, which is one change; Esc calls it off.
 *
 * In full screen a frame only moves along its row (`alongAt`), and held near
 * the board's left or right side it scrolls the row along.
 */

import * as Y from "yjs";

import { allFrames, applyLayout, moveFrame, own, readTree } from "@/lib/board";
import { currentDrag, setDrag, type Drag } from "@/lib/drag";
import { edgeScroll, scrollsFurther } from "@/lib/fullscreen";
import {
  alongAt,
  clusterPoint,
  dropAt,
  dropPoint,
  moveCluster,
  pin,
  resolve,
  slotAt,
  without,
  type Point,
} from "../../shared/layout";

export interface DragStart {
  readonly doc: Y.Doc;
  readonly what:
    | { readonly kind: "frame"; readonly id: string }
    | { readonly kind: "cluster"; readonly id: string };
  /** The dragged thing's top-left on the board. */
  readonly origin: Point;
  /** In full screen: along this row; `scroll` moves the view, `show` goes back to the frame. */
  readonly along?: {
    readonly row: string;
    readonly scroll: (dx: number) => void;
    readonly show: () => void;
  } | null;
}

/** How far the pointer goes before a press is a drag, in px. */
const THRESHOLD = 3;

export function startDrag(event: React.PointerEvent, start: DragStart) {
  if (event.button !== 0) return;
  const board = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-board]");
  if (!board) return;
  const scale = Number(board.style.getPropertyValue("--board-scale") || 1);
  const { doc, what, origin, along = null } = start;
  const [px, py] = [event.clientX, event.clientY];
  const box = board.getBoundingClientRect();
  // Where on the board the press was: the same point of the dragged thing stays under the pointer.
  const canvas = board.firstElementChild!.getBoundingClientRect();
  const pressed = { x: (px - canvas.left) / scale, y: (py - canvas.top) / scale };
  const grab = { x: pressed.x - origin.x, y: pressed.y - origin.y };
  const frames = new Set(
    what.kind === "frame"
      ? [what.id]
      : allFrames(doc)
          .filter((f) => f.cluster === what.id)
          .map((f) => f.id),
  );
  // The board without it: what is under the pointer doesn't move as the others make room.
  // A frame's clusters stay where they were, as the preview shows them.
  const tree = readTree(doc);
  const lifted = resolve(without(tree, frames));
  const rest = what.kind === "frame" ? pin(lifted, resolve(tree)) : lifted;
  const height = allFrames(doc).find((f) => f.id === what.id)?.h ?? 0;
  let pointer = { x: px, y: py };
  let alt = event.altKey;
  let scrolled = 0;
  let dragging = false;
  let raf = 0;

  const drag = (): Drag => {
    const at = {
      x: pressed.x + (pointer.x - px) / scale + scrolled,
      y: pressed.y + (along ? 0 : (pointer.y - py) / scale),
    };
    if (what.kind === "cluster")
      return {
        kind: "cluster",
        cluster: what.id,
        pointer: at,
        grab,
        to: slotAt(rest, clusterPoint(at, grab)),
      };
    const target = along
      ? alongAt(rest, along.row, at.x)
      : dropAt(rest, dropPoint(at, grab, height), { newCluster: alt });
    return { kind: "frame", frame: what.id, pointer: at, grab, target, along: !!along };
  };

  /** Near the board's side, scroll the row along every animation frame, the frame with it. */
  const edge = () => {
    raf = requestAnimationFrame(edge);
    if (!along || !dragging) return;
    const v = edgeScroll(pointer.x, box.left, box.right);
    const row = allFrames(doc).filter((f) => f.row === along.row);
    const moving = row.find((f) => f.id === what.id);
    const now = currentDrag();
    if (!moving || !now) return;
    const here = { ...moving, x: now.pointer.x - grab.x };
    if (!scrollsFurther(row, here, v)) return;
    along.scroll(v);
    scrolled += v;
    setDrag(drag());
  };
  if (along) raf = requestAnimationFrame(edge);

  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    alt = e.altKey;
    if (!dragging && Math.hypot(pointer.x - px, pointer.y - py) <= THRESHOLD) return;
    // A text selection would be dragged along by the browser, calling ours off.
    if (!dragging) getSelection()?.removeAllRanges();
    dragging = true;
    setDrag(drag());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dragging) {
      // Only the drag: not full screen too.
      e.preventDefault();
      e.stopPropagation();
      return finish(false);
    }
    if (e.key !== "Alt" || !dragging) return;
    alt = e.type === "keydown";
    setDrag(drag());
  };
  const finish = (drop: boolean) => {
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onCancel);
    removeEventListener("keydown", onKey, true);
    removeEventListener("keyup", onKey, true);
    const last = dragging ? drag() : null;
    setDrag(null);
    if (!drop || !last) return;
    own(doc, () => {
      if (last.kind === "frame" && last.target) moveFrame(doc, last.frame, last.target);
      if (last.kind === "cluster")
        applyLayout(doc, moveCluster(readTree(doc), last.cluster, last.to));
    });
    along?.show();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onCancel);
  addEventListener("keydown", onKey, true);
  addEventListener("keyup", onKey, true);
}
