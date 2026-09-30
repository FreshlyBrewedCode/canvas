import { describe, expect, test } from "bun:test";

import { clusters, GAP, type Rect } from "./layout";

const r = (id: string, x: number, y: number, w = 100, h = 100): Rect => ({ id, x, y, w, h });
describe("clusters", () => {
  test("frames within reach of each other are one cluster, transitively", () => {
    const rects = [r("a", 0, 0), r("b", 100 + GAP, 0), r("c", 200 + 2 * GAP, 0), r("far", 2000, 0)];
    const found = clusters(rects);
    expect(found.map((c) => c.frames.map((f) => f.id).sort())).toEqual([["a", "b", "c"], ["far"]]);
  });

  test("rows group frames by top edge, left to right", () => {
    const rects = [r("b", 124, 0), r("a", 0, 4), r("c", 0, 124)];
    const [cluster] = clusters(rects);
    expect(cluster!.rows.map((row) => row.map((f) => f.id))).toEqual([["a", "b"], ["c"]]);
  });

  test("a cluster is named after its first frame id and has bounds", () => {
    const [cluster] = clusters([r("z", 10, 20), r("m", 134, 20, 100, 200)]);
    expect(cluster!.id).toBe("m");
    expect(cluster!.bounds).toEqual({ x: 10, y: 20, w: 224, h: 200 });
  });
});
