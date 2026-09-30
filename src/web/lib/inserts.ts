// The "+" on a frame's edge: where frames can be added beside others. The
// geometry, free of the DOM.

import type { Beside, Point, Rect } from "../../shared/layout";

/** A frame as the board shows it, with its place in the tree. */
export interface Placed extends Rect {
  readonly row: string;
  readonly column: string;
}

/**
 * A vertical edge of a row where a frame can go: between two columns (the
 * edge they share: one, not one per frame), or at the row's left or right end.
 */
export interface InsertEdge {
  /** Stable while the edge is there: its target. */
  readonly key: string;
  readonly x: number;
  /** The edge's extent: that of the frames either side of it. */
  readonly top: number;
  readonly bottom: number;
  /** Right of the column before it, or left of the row's first. */
  readonly target: Beside;
}

/** Every row's vertical edges, from the frames as shown. */
export function insertEdges(frames: ReadonlyArray<Placed>): InsertEdge[] {
  const rows = new Map<string, Map<string, Placed[]>>();
  for (const f of frames) {
    const columns = rows.get(f.row) ?? new Map<string, Placed[]>();
    rows.set(f.row, columns.set(f.column, [...(columns.get(f.column) ?? []), f]));
  }
  const edges: InsertEdge[] = [];
  for (const columns of rows.values()) {
    const cols = [...columns.values()]
      .map((of) => {
        const top = Math.min(...of.map((f) => f.y));
        return {
          x: Math.min(...of.map((f) => f.x)),
          right: Math.max(...of.map((f) => f.x + f.w)),
          top,
          bottom: Math.max(...of.map((f) => f.y + f.h)),
          // Its top frame stands for it: a frame beside it goes in a column of its own.
          anchor: of.find((f) => f.y === top)!.id,
        };
      })
      .sort((a, b) => a.x - b.x);
    for (let i = 0; i <= cols.length; i++) {
      const before = cols[i - 1];
      const after = cols[i];
      const either = [before, after].filter((c) => c !== undefined);
      const target: Beside = before
        ? { anchor: before.anchor, side: "right" }
        : { anchor: after!.anchor, side: "left" };
      edges.push({
        key: `${target.anchor}:${target.side}`,
        x: before ? before.right : after!.x,
        top: Math.min(...either.map((c) => c.top)),
        bottom: Math.max(...either.map((c) => c.bottom)),
        target,
      });
    }
  }
  return edges;
}

/** The edge nearest a point, if it is within `reach` of it, beside the edge's extent. */
export function edgeNear(
  edges: ReadonlyArray<InsertEdge>,
  point: Point,
  reach: number,
): InsertEdge | null {
  let best: InsertEdge | null = null;
  for (const e of edges) {
    if (point.y < e.top || point.y > e.bottom) continue;
    const d = Math.abs(point.x - e.x);
    if (d <= reach && (!best || d < Math.abs(point.x - best.x))) best = e;
  }
  return best;
}
