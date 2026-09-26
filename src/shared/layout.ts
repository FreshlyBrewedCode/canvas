/**
 * The board's layout rules, as pure geometry.
 *
 * Frame positions stay the only truth (the board doc stores x, y, w, h);
 * structure is read off them:
 *
 *   cluster  frames within `NEAR` of each other, transitively — what people
 *            group together belongs together
 *   row      frames of a cluster whose top edges line up, left to right
 *
 * Placing a frame (by a person's drop or an agent's tool call) returns the
 * new frame's rect and patches for the frames that make room: frames later in
 * the row shift right, rows further down shift down. Nothing outside the
 * anchor's cluster moves. Anything placed away from other frames stays free.
 * A frame leaving (moved or removed) closes its gap the same way, reversed.
 */

export interface Rect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type Box = Omit<Rect, "id">;
export type Size = Pick<Rect, "w" | "h">;
export type Patch = { readonly id: string } & Partial<Box>;
export type Side = "left" | "right" | "above" | "below";
export interface Target {
  readonly anchor: string;
  readonly side: Side;
}

export interface Cluster<R extends Rect = Rect> {
  /** The smallest frame id in it: stable while that frame stays. */
  readonly id: string;
  readonly frames: ReadonlyArray<R>;
  /** Top to bottom; each left to right. */
  readonly rows: ReadonlyArray<ReadonlyArray<R>>;
  readonly bounds: Box;
}

/** Space between frames in a cluster. */
export const GAP = 24;
/** Frames this close (or closer) are one cluster. */
export const NEAR = 48;
/** Top edges this close are one row. */
const ROW_TOLERANCE = 16;

/** Empty space between two rects along each axis (0 when they overlap on it). */
function gaps(a: Box, b: Box) {
  return {
    x: Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)),
    y: Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)),
  };
}

const near = (a: Box, b: Box) => {
  const g = gaps(a, b);
  return g.x <= NEAR && g.y <= NEAR;
};

export function clusters<R extends Rect>(rects: ReadonlyArray<R>): Cluster<R>[] {
  const seen = new Set<string>();
  const found: Cluster<R>[] = [];
  for (const start of rects) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const members = [start];
    for (let i = 0; i < members.length; i++)
      for (const other of rects)
        if (!seen.has(other.id) && near(members[i]!, other)) {
          seen.add(other.id);
          members.push(other);
        }
    found.push(cluster(members));
  }
  return found.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function cluster<R extends Rect>(members: R[]): Cluster<R> {
  const rows: R[][] = [];
  for (const frame of [...members].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(frame.y - row[0]!.y) <= ROW_TOLERANCE) row.push(frame);
    else rows.push([frame]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  const x = Math.min(...members.map((f) => f.x));
  const y = Math.min(...members.map((f) => f.y));
  return {
    id: members.map((f) => f.id).sort()[0]!,
    frames: members,
    rows,
    bounds: {
      x,
      y,
      w: Math.max(...members.map((f) => f.x + f.w)) - x,
      h: Math.max(...members.map((f) => f.y + f.h)) - y,
    },
  };
}

/** The cluster and row a frame is in. */
export function locate<R extends Rect>(rects: ReadonlyArray<R>, id: string) {
  for (const c of clusters(rects)) {
    const row = c.rows.find((r) => r.some((f) => f.id === id));
    if (row) return { cluster: c, row, frame: row.find((f) => f.id === id)! };
  }
  throw new Error(`no frame ${id}`);
}

const rowBottom = (row: ReadonlyArray<Rect>) => Math.max(...row.map((f) => f.y + f.h));

/** Where a new frame of `size` goes next to `target.anchor`, and what moves for it. */
export function placeNew(
  rects: ReadonlyArray<Rect>,
  target: Target,
  size: Size,
): { rect: Box; patches: Patch[] } {
  const { cluster: c, row, frame: anchor } = locate(rects, target.anchor);
  switch (target.side) {
    case "right":
    case "left": {
      const rect = {
        x: target.side === "right" ? anchor.x + anchor.w + GAP : anchor.x,
        y: anchor.y,
        w: size.w,
        h: anchor.h,
      };
      const moves = (f: Rect) => (target.side === "right" ? f.x > anchor.x : f.x >= anchor.x);
      return {
        rect,
        patches: row.filter(moves).map((f) => ({ id: f.id, x: f.x + size.w + GAP })),
      };
    }
    case "below":
    case "above": {
      const y = target.side === "below" ? rowBottom(row) + GAP : row[0]!.y;
      const from = target.side === "below" ? rowBottom(row) : y;
      return {
        rect: { x: anchor.x, y, w: size.w, h: size.h },
        patches: c.frames
          .filter((f) => f.y >= from)
          .map((f) => ({ id: f.id, y: f.y + size.h + GAP })),
      };
    }
  }
}

/**
 * Where an agent's new frame goes: its own cluster, without running into
 * another cluster — the end of its row, else a row under it, else under the
 * whole cluster (taken even if it touches another cluster).
 */
export function placeNear(
  rects: ReadonlyArray<Rect>,
  selfId: string,
  size: Size,
): { rect: Box; patches: Patch[] } {
  const { cluster: c, row } = locate(rects, selfId);
  const bottom = {
    rect: { x: c.bounds.x, y: c.bounds.y + c.bounds.h + GAP, ...size },
    patches: [],
  };
  const candidates = [
    placeNew(rects, { anchor: row.at(-1)!.id, side: "right" }, size),
    placeNew(rects, { anchor: row[0]!.id, side: "below" }, size),
    bottom,
  ];
  const inCluster = new Set(c.frames.map((f) => f.id));
  const outside = rects.filter((f) => !inCluster.has(f.id));
  return (
    candidates.find(({ rect, patches }) => {
      const moved = [rect, ...applyPatches(c.frames, patches)];
      return !moved.some((m) => outside.some((o) => near(m, o)));
    }) ?? bottom
  );
}

/**
 * A frame leaves its place: the frames after it in its row close the gap, or,
 * when it was alone in its row, the rows below move up into it.
 */
export function lift(rects: ReadonlyArray<Rect>, id: string): Patch[] {
  const { cluster: c, row, frame } = locate(rects, id);
  if (row.length > 1)
    return row.filter((f) => f.x > frame.x).map((f) => ({ id: f.id, x: f.x - frame.w - GAP }));
  const below = c.rows.slice(c.rows.indexOf(row) + 1).flat();
  if (below.length === 0) return [];
  const dy = Math.min(...below.map((f) => f.y)) - frame.y;
  return below.map((f) => ({ id: f.id, y: f.y - dy }));
}

/**
 * Whether placing next to `target` goes in between two frames — two of a
 * row, or two rows — and if so the gap's centre line (`w` or `h` is 0), for a
 * drop's preview. `movingId`, the frame being placed, is no neighbour.
 */
export function insertion(
  rects: ReadonlyArray<Rect>,
  target: Target,
  movingId?: string,
): Box | null {
  const rest = rects.filter((f) => f.id !== movingId);
  const { cluster: c, row, frame: anchor } = locate(rest, target.anchor);
  switch (target.side) {
    case "right":
    case "left": {
      const i = row.indexOf(anchor);
      const [l, r] = target.side === "right" ? [anchor, row[i + 1]] : [row[i - 1], anchor];
      if (!l || !r) return null;
      const y = Math.min(l.y, r.y);
      return { x: (l.x + l.w + r.x) / 2, y, w: 0, h: Math.max(l.y + l.h, r.y + r.h) - y };
    }
    case "below":
    case "above": {
      const i = c.rows.indexOf(row);
      const [upper, lower] = target.side === "below" ? [row, c.rows[i + 1]] : [c.rows[i - 1], row];
      if (!upper || !lower) return null;
      const y = (rowBottom(upper) + Math.min(...lower.map((f) => f.y))) / 2;
      return { x: c.bounds.x, y, w: c.bounds.w, h: 0 };
    }
  }
}

/** Where a frame being dragged would snap to: next to the nearest frame within reach. */
export function snapTarget(rects: ReadonlyArray<Rect>, movingId: string): Target | null {
  const moving = rects.find((f) => f.id === movingId);
  if (!moving) return null;
  const centre = (f: Box) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
  const mc = centre(moving);
  let best: { frame: Rect; distance: number; gap: number } | null = null;
  for (const frame of rects) {
    if (frame.id === movingId || !near(moving, frame)) continue;
    const g = gaps(moving, frame);
    const fc = centre(frame);
    const distance = Math.hypot(mc.x - fc.x, mc.y - fc.y);
    const gap = g.x + g.y;
    if (!best || gap < best.gap || (gap === best.gap && distance < best.distance))
      best = { frame, distance, gap };
  }
  if (!best) return null;
  const fc = centre(best.frame);
  const dx = (mc.x - fc.x) / ((best.frame.w + moving.w) / 2);
  const dy = (mc.y - fc.y) / ((best.frame.h + moving.h) / 2);
  const side: Side =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "below" : "above";
  return { anchor: best.frame.id, side };
}

/** Move an existing frame next to `target`: it leaves its row, then is placed like a new one. */
export function moveFrame(rects: ReadonlyArray<Rect>, id: string, target: Target): Patch[] {
  const frame = rects.find((f) => f.id === id);
  if (!frame) throw new Error(`no frame ${id}`);
  const lifted = lift(rects, id);
  const rest = applyPatches(rects, lifted).filter((f) => f.id !== id);
  const { rect, patches } = placeNew(rest, target, frame);
  return merge([...lifted, ...patches, { id, ...rect }]);
}

/**
 * Resize a frame and keep its row a row: the others take its height, the
 * frames to its right follow its width, and rows below move with the row's
 * bottom edge.
 */
export function resizeInRow(rects: ReadonlyArray<Rect>, id: string, size: Size): Patch[] {
  const { cluster: c, row, frame } = locate(rects, id);
  const patches: Patch[] = [{ id, w: size.w, h: size.h }];
  if (row.length === 1) return patches;
  const dw = size.w - frame.w;
  for (const f of row)
    if (f.id !== id)
      patches.push(f.x > frame.x ? { id: f.id, x: f.x + dw, h: size.h } : { id: f.id, h: size.h });
  const before = rowBottom(row);
  const after = rowBottom(applyPatches(row, patches));
  if (after !== before)
    for (const f of c.frames)
      if (!row.includes(f) && f.y >= before) patches.push({ id: f.id, y: f.y + after - before });
  return patches;
}

export function applyPatches<R extends Rect>(
  rects: ReadonlyArray<R>,
  patches: ReadonlyArray<Patch>,
): R[] {
  const byId = new Map(merge(patches).map((p) => [p.id, p]));
  return rects.map((r) => (byId.has(r.id) ? { ...r, ...byId.get(r.id) } : r));
}

/** One patch per frame; later patches win field by field. */
function merge(patches: ReadonlyArray<Patch>): Patch[] {
  const byId = new Map<string, Patch>();
  for (const patch of patches) byId.set(patch.id, { ...byId.get(patch.id), ...patch });
  return [...byId.values()];
}
