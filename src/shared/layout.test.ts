import { describe, expect, test } from "bun:test";

import {
  applyPatches,
  clusters,
  GAP,
  insertion,
  lift,
  moveFrame,
  placeNear,
  placeNew,
  resizeInRow,
  snapTarget,
  type Rect,
} from "./layout";

const r = (id: string, x: number, y: number, w = 100, h = 100): Rect => ({ id, x, y, w, h });
const byId = (rects: ReadonlyArray<Rect>) =>
  Object.fromEntries(rects.map((rect) => [rect.id, rect]));

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

describe("placeNew", () => {
  test("right of a frame: takes the row's height, later row frames shift right", () => {
    const rects = [r("a", 0, 0, 100, 300), r("b", 124, 0, 100, 300)];
    const { rect, patches } = placeNew(rects, { anchor: "a", side: "right" }, { w: 200, h: 50 });
    expect(rect).toEqual({ x: 124, y: 0, w: 200, h: 300 });
    expect(patches).toEqual([{ id: "b", x: 124 + 200 + GAP }]);
  });

  test("left of a frame: takes its place, it and later frames shift right", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0)];
    const { rect, patches } = placeNew(rects, { anchor: "b", side: "left" }, { w: 50, h: 50 });
    expect(rect).toEqual({ x: 124, y: 0, w: 50, h: 100 });
    expect(patches).toEqual([{ id: "b", x: 124 + 50 + GAP }]);
  });

  test("below a frame: a new row under its row; rows further down shift down", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0, 100, 200), r("c", 0, 224)];
    const { rect, patches } = placeNew(rects, { anchor: "a", side: "below" }, { w: 300, h: 80 });
    expect(rect).toEqual({ x: 0, y: 224, w: 300, h: 80 });
    expect(patches).toEqual([{ id: "c", y: 224 + 80 + GAP }]);
  });

  test("above a frame: a new row where its row was; it and the rows below shift down", () => {
    const rects = [r("a", 0, 0), r("b", 0, 124)];
    const { rect, patches } = placeNew(rects, { anchor: "b", side: "above" }, { w: 60, h: 60 });
    expect(rect).toEqual({ x: 0, y: 124, w: 60, h: 60 });
    expect(patches).toEqual([{ id: "b", y: 124 + 60 + GAP }]);
  });

  test("shifts stay inside the anchor's cluster", () => {
    const rects = [r("a", 0, 0), r("elsewhere", 0, 5000)];
    const { patches } = placeNew(rects, { anchor: "a", side: "below" }, { w: 100, h: 100 });
    expect(patches).toEqual([]);
  });
});

describe("placeNear", () => {
  test("appends to the end of the agent's own row", () => {
    const rects = [r("agent", 0, 0, 100, 400), r("f", 124, 0, 100, 400)];
    const { rect } = placeNear(rects, "agent", { w: 200, h: 100 });
    expect(rect).toEqual({ x: 248, y: 0, w: 200, h: 400 });
  });

  test("starts a row below when the row would run into another cluster", () => {
    const rects = [r("agent", 0, 0), r("other", 124 + 150, 0)];
    const { rect } = placeNear(rects, "agent", { w: 200, h: 50 });
    expect(rect).toEqual({ x: 0, y: 124, w: 200, h: 50 });
  });

  test("goes below the whole cluster when a row under its own would push into another", () => {
    const rects = [
      r("agent", 0, 0, 100, 300),
      r("under", 0, 324, 400, 100),
      // Blocks the end of the agent's row.
      r("block", 254, 0),
      // Clear of "under" until "under" is pushed down.
      r("wall", 430, 520),
    ];
    const { rect, patches } = placeNear(rects, "agent", { w: 100, h: 100 });
    expect(rect).toEqual({ x: 0, y: 448, w: 100, h: 100 });
    expect(patches).toEqual([]);
  });
});

describe("lift", () => {
  test("closes the gap a frame leaves in its row", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0), r("c", 248, 0), r("d", 0, 124)];
    expect(lift(rects, "b")).toEqual([{ id: "c", x: 124 }]);
  });

  test("a frame alone in its row: the rows below move up into its place", () => {
    const rects = [r("a", 0, 0), r("b", 0, 124, 100, 200), r("c", 0, 348), r("d", 124, 348)];
    expect(lift(rects, "b")).toEqual([
      { id: "c", y: 124 },
      { id: "d", y: 124 },
    ]);
  });

  test("the last row leaves no patches; other clusters stay", () => {
    const rects = [r("a", 0, 0), r("b", 0, 124), r("far", 0, 2000)];
    expect(lift(rects, "b")).toEqual([]);
    expect(lift(rects, "a")).toEqual([{ id: "b", y: 0 }]);
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

describe("moveFrame", () => {
  test("moves a frame between rows: gap closes, frame takes its new row's height", () => {
    const rects = [
      r("a", 0, 0, 100, 300),
      r("b", 124, 0, 100, 300),
      r("m", 0, 324, 80, 80),
      r("n", 104, 324),
    ];
    const patches = moveFrame(rects, "m", { anchor: "b", side: "right" });
    const after = byId(applyPatches(rects, patches));
    expect(after.m).toEqual(r("m", 248, 0, 80, 300));
    expect(after.n!.x).toBe(0);
  });

  test("leaves its old row closed up when it moves to another cluster", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0), r("c", 248, 0), r("d", 1000, 0)];
    const after = byId(applyPatches(rects, moveFrame(rects, "b", { anchor: "d", side: "right" })));
    expect(after.b).toEqual(r("b", 1124, 0));
    expect(after.c!.x).toBe(124);
  });

  test("moving a row's only frame below the next row: that row moves up first", () => {
    const rects = [r("a", 0, 0), r("b", 0, 124), r("c", 0, 248)];
    const after = byId(applyPatches(rects, moveFrame(rects, "a", { anchor: "c", side: "below" })));
    expect([after.b!.y, after.c!.y, after.a!.y]).toEqual([0, 124, 248]);
  });

  test("reorders within a row", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0), r("c", 248, 0)];
    const after = byId(applyPatches(rects, moveFrame(rects, "c", { anchor: "a", side: "left" })));
    expect([after.c!.x, after.a!.x, after.b!.x]).toEqual([0, 124, 248]);
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

describe("resizeInRow", () => {
  test("height follows the row, frames to the right follow the width, rows below move", () => {
    const rects = [r("a", 0, 0), r("b", 124, 0), r("c", 248, 0), r("below", 0, 124)];
    const patches = resizeInRow(rects, "b", { w: 150, h: 160 });
    expect(patches).toEqual([
      { id: "b", w: 150, h: 160 },
      { id: "a", h: 160 },
      { id: "c", x: 298, h: 160 },
      { id: "below", y: 184 },
    ]);
  });

  test("a frame alone in its row only resizes", () => {
    expect(resizeInRow([r("a", 0, 0)], "a", { w: 50, h: 50 })).toEqual([{ id: "a", w: 50, h: 50 }]);
  });
});
