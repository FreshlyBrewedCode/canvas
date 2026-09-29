// Pan/zoom arithmetic for the board, kept free of the DOM so it can be
// reasoned about — and tested — without a browser. Adapted from wayful's
// graph viewport; the board is unbounded, so there is no pan constraint.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2.5;

export interface Transform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** Zoom about a viewport point, so whatever is under it stays under it. */
export function zoomAbout(t: Transform, nextScale: number, px: number, py: number): Transform {
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  if (scale === t.scale) return t;
  return {
    scale,
    x: px - (px - t.x) * (scale / t.scale),
    y: py - (py - t.y) * (scale / t.scale),
  };
}

/** Viewport pixels → board coordinates. */
export const toBoard = (t: Transform, p: Point): Point => ({
  x: (p.x - t.x) / t.scale,
  y: (p.y - t.y) / t.scale,
});

/** The board point at the centre of a viewport. */
export const centreOf = (t: Transform, width: number, height: number): Point =>
  toBoard(t, { x: width / 2, y: height / 2 });

/** Fit a set of rectangles (board coordinates) into the viewport, never magnifying past 1. */
export function fitRects(
  rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  width: number,
  height: number,
  pad = 60,
): Transform | null {
  if (!rects.length || !width || !height) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const scale = clamp(
    Math.min((width - pad * 2) / (right - left), (height - pad * 2) / (bottom - top), 1),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    x: (width - (right - left) * scale) / 2 - left * scale,
    y: (height - (bottom - top) * scale) / 2 - top * scale,
  };
}

/** Is a rectangle (board coordinates) wholly in the viewport, at a scale it can be read at? */
export function inView(
  t: Transform,
  rect: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  minScale = 0.5,
): boolean {
  const left = rect.x * t.scale + t.x;
  const top = rect.y * t.scale + t.y;
  return (
    t.scale >= minScale &&
    left >= 0 &&
    top >= 0 &&
    left + rect.w * t.scale <= width &&
    top + rect.h * t.scale <= height
  );
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The part of the board a viewport shows, in board coordinates. */
export const viewRect = (t: Transform, width: number, height: number): Rect => ({
  x: -t.x / t.scale,
  y: -t.y / t.scale,
  w: width / t.scale,
  h: height / t.scale,
});

/** Board coordinates → viewport pixels. */
export const toViewport = (t: Transform, p: Point): Point => ({
  x: p.x * t.scale + t.x,
  y: p.y * t.scale + t.y,
});

/**
 * Where to point at a viewport point that lies outside the viewport: on the
 * line from the centre to it, where it meets the viewport inset by `inset`,
 * and the direction it lies in (radians, 0 = up, clockwise). Null when the
 * point is in view.
 */
export function edgeMarker(
  p: Point,
  width: number,
  height: number,
  inset: { top: number; right: number; bottom: number; left: number },
): { x: number; y: number; angle: number } | null {
  if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) return null;
  const cx = width / 2;
  const cy = height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const along = (d: number, low: number, high: number, c: number) =>
    d > 0 ? (high - c) / d : d < 0 ? (low - c) / d : Infinity;
  const s = Math.max(
    0,
    Math.min(
      along(dx, inset.left, width - inset.right, cx),
      along(dy, inset.top, height - inset.bottom, cy),
    ),
  );
  return { x: cx + dx * s, y: cy + dy * s, angle: Math.atan2(dx, -dy) };
}

/** Show a view someone else has (board coordinates): all of it, centred, at any scale. */
export function fitView(view: Rect, width: number, height: number): Transform {
  const scale = clamp(Math.min(width / view.w, height / view.h), MIN_SCALE, MAX_SCALE);
  return {
    scale,
    x: width / 2 - (view.x + view.w / 2) * scale,
    y: height / 2 - (view.y + view.h / 2) * scale,
  };
}
