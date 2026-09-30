import { describe, expect, test } from "bun:test";

import { clusters, GAP, insertion, snapTarget, type Rect } from "./layout";

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

describe("snapTarget", () => {
  test("right of the nearest frame when dropped beside it", () => {
    const rects = [r("a", 0, 0), r("m", 130, 10)];
    expect(snapTarget(rects, "m")).toEqual({ anchor: "a", side: "right" });
  });

  test("below when dropped under it", () => {
    const rects = [r("a", 0, 0), r("m", 10, 120)];
    expect(snapTarget(rects, "m")).toEqual({ anchor: "a", side: "below" });
  });

  test("nothing when nothing is within reach", () => {
    expect(snapTarget([r("a", 0, 0), r("m", 900, 0)], "m")).toBeNull();
  });
});

describe("insertion", () => {
  const row = [r("a", 0, 0), r("b", 124, 0, 100, 150), r("c", 0, 174)];

  test("between two frames of a row: a vertical line in the gap, as tall as the row", () => {
    expect(insertion(row, { anchor: "a", side: "right" })).toEqual({ x: 112, y: 0, w: 0, h: 150 });
    expect(insertion(row, { anchor: "b", side: "left" })).toEqual({ x: 112, y: 0, w: 0, h: 150 });
  });

  test("between two rows: a horizontal line in the gap, as wide as the cluster", () => {
    expect(insertion(row, { anchor: "a", side: "below" })).toEqual({ x: 0, y: 162, w: 224, h: 0 });
    expect(insertion(row, { anchor: "c", side: "above" })).toEqual({ x: 0, y: 162, w: 224, h: 0 });
  });

  test("nothing at a cluster's edge", () => {
    expect(insertion(row, { anchor: "b", side: "right" })).toBeNull();
    expect(insertion(row, { anchor: "a", side: "left" })).toBeNull();
    expect(insertion(row, { anchor: "a", side: "above" })).toBeNull();
    expect(insertion(row, { anchor: "c", side: "below" })).toBeNull();
  });

  test("the moving frame is not a neighbour", () => {
    const rects = [r("a", 0, 0), r("m", 124, 0)];
    expect(insertion(rects, { anchor: "a", side: "right" }, "m")).toBeNull();
  });
});
