// Full screen (finding 20): one person's own view of a row at 100%, its
// frames as tall as their screen. The geometry, free of the DOM.

import { clusters, type Rect } from "../../shared/layout";
import type { Transform } from "./viewport";

export interface FullscreenRow<R extends Rect = Rect> {
  /** Left to right. */
  readonly frames: ReadonlyArray<R>;
  /** Its highest top edge: where the screen's top is. */
  readonly top: number;
}

/** The row a frame is in (`shared/layout.ts`); null once the frame is gone. */
export function fullscreenRow<R extends Rect>(
  rects: ReadonlyArray<R>,
  id: string,
): FullscreenRow<R> | null {
  for (const c of clusters(rects)) {
    const row = c.rows.find((r) => r.some((f) => f.id === id));
    if (row) return { frames: row, top: Math.min(...row.map((f) => f.y)) };
  }
  return null;
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
