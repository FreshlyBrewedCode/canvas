// Full screen (finding 20): one person's own view of a row at 100%, its
// frames as tall as their screen. The geometry, free of the DOM.

import type { Beside, Rect } from "../../shared/layout";
import type { Transform } from "./viewport";

export interface FullscreenRow<R extends Rect = Rect> {
  /** Left to right. */
  readonly frames: ReadonlyArray<R>;
  /** Its highest top edge: where the screen's top is. */
  readonly top: number;
}

/** The row a frame is in (ADR 0010); null once the frame is gone. */
export function fullscreenRow<R extends Rect & { readonly row: string }>(
  frames: ReadonlyArray<R>,
  id: string,
): FullscreenRow<R> | null {
  const frame = frames.find((f) => f.id === id);
  if (!frame) return null;
  const row = frames.filter((f) => f.row === frame.row).sort((a, b) => a.x - b.x);
  return { frames: row, top: Math.min(...row.map((f) => f.y)) };
}

/** Show a frame at 100%, the row's top at the screen's: centred, or from its left edge if wider. */
export function fullscreenTransform(
  frame: Pick<Rect, "x" | "w">,
  top: number,
  width: number,
): Transform {
  const left = frame.w <= width ? (width - frame.w) / 2 : 0;
  return { scale: 1, x: left - frame.x, y: -top };
}

/** The frame of the row nearest the middle of the screen. */
export function currentIn(row: ReadonlyArray<Rect>, t: Transform, width: number): string | null {
  const middle = (width / 2 - t.x) / t.scale;
  let best: Rect | null = null;
  for (const f of row)
    if (!best || Math.abs(f.x + f.w / 2 - middle) < Math.abs(best.x + best.w / 2 - middle))
      best = f;
  return best?.id ?? null;
}

/** Whether a view still shows the row as full screen does: at 100%, the row's top at the top. */
export const stillFullscreen = (t: Transform, top: number) =>
  t.scale === 1 && Math.abs(t.y + top) < 0.5;

/**
 * The frame full screen goes on to when `id` is gone: the next of the row as
 * it was (`order`, left to right), else the one before; null when none is left.
 */
export function standIn(
  order: ReadonlyArray<string>,
  id: string,
  present: ReadonlySet<string>,
): string | null {
  const at = order.indexOf(id);
  if (at < 0) return null;
  const after = order.slice(at + 1).find((f) => present.has(f));
  return after ?? order.slice(0, at).findLast((f) => present.has(f)) ?? null;
}

/** How far in from the board's side a drag along the row starts scrolling it, in px. */
export const EDGE = 80;
/** The fastest it scrolls, at the side or past it, in px per animation frame. */
const EDGE_SPEED = 24;

/**
 * How far a drag along the row scrolls the view this animation frame: the
 * deeper the pointer is into the edge zone of the board (`left`…`right`, client
 * px), the faster; negative is to the left.
 */
export function edgeScroll(clientX: number, left: number, right: number): number {
  // Into the zone on the right is positive, on the left negative.
  const depth = Math.max(clientX - (right - EDGE), 0) - Math.max(left + EDGE - clientX, 0);
  if (!depth) return 0;
  return Math.sign(depth) * Math.round(Math.min(Math.abs(depth) / EDGE, 1) * EDGE_SPEED);
}

/**
 * Whether scrolling by `v` still brings the dragged frame somewhere new: not
 * once it is past the row's last frame (going right) or its first (going left).
 */
export function scrollsFurther(row: ReadonlyArray<Rect>, moving: Rect, v: number): boolean {
  const others = row.filter((f) => f.id !== moving.id);
  if (!v || !others.length) return false;
  if (v > 0) return moving.x < Math.max(...others.map((f) => f.x + f.w));
  return moving.x + moving.w > Math.min(...others.map((f) => f.x));
}

/**
 * Where a frame dragged along its row goes: after the last of the others whose
 * middle it is past, or before the first. Null when the row has no others.
 */
export function rowTarget(row: ReadonlyArray<Rect>, moving: Rect): Beside | null {
  const others = row.filter((f) => f.id !== moving.id).sort((a, b) => a.x - b.x);
  const middle = moving.x + moving.w / 2;
  const before = others.filter((f) => f.x + f.w / 2 < middle).at(-1);
  if (before) return { anchor: before.id, side: "right" };
  return others[0] ? { anchor: others[0].id, side: "left" } : null;
}
