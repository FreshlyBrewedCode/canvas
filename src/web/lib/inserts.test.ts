import { describe, expect, test } from "bun:test";

import { edgeNear, insertEdges } from "./inserts";

// A row of a, then b over c in one column, then d; and a frame on its own further right.
const frames = [
  { id: "a", row: "r1", column: "ca", x: 0, y: 0, w: 400, h: 600 },
  { id: "b", row: "r1", column: "cb", x: 400, y: 0, w: 300, h: 300 },
  { id: "c", row: "r1", column: "cb", x: 400, y: 300, w: 300, h: 300 },
  { id: "d", row: "r1", column: "cd", x: 700, y: 0, w: 500, h: 600 },
  { id: "e", row: "r2", column: "ce", x: 1320, y: 0, w: 400, h: 300 },
];

describe("inserts", () => {
  test("one edge per column boundary: shared edges once, the row's ends too", () => {
    const edges = insertEdges(frames);
    expect(edges.map((e) => [e.key, e.x, e.top, e.bottom])).toEqual([
      ["a:left", 0, 0, 600],
      ["a:right", 400, 0, 600],
      ["b:right", 700, 0, 600],
      ["d:right", 1200, 0, 600],
      ["e:left", 1320, 0, 300],
      ["e:right", 1720, 0, 300],
    ]);
    expect(edges[2]!.target).toEqual({ anchor: "b", side: "right" });
  });

  test("an edge's extent is the frames either side of it: a short terminal in full screen", () => {
    const shown = [
      { id: "t", row: "r", column: "ct", x: 0, y: 0, w: 400, h: 200 },
      { id: "f", row: "r", column: "cf", x: 400, y: 0, w: 400, h: 800 },
    ];
    expect(insertEdges(shown).map((e) => [e.key, e.top, e.bottom])).toEqual([
      ["t:left", 0, 200],
      ["t:right", 0, 800],
      ["f:right", 0, 800],
    ]);
  });

  test("the nearest edge within reach, from either side of it", () => {
    const edges = insertEdges(frames);
    // Just inside a, or just inside b: the edge they share.
    expect(edgeNear(edges, { x: 390, y: 100 }, 24)?.key).toBe("a:right");
    expect(edgeNear(edges, { x: 410, y: 500 }, 24)?.key).toBe("a:right");
    // Between b and c, beside the edge of their column.
    expect(edgeNear(edges, { x: 690, y: 300 }, 24)?.key).toBe("b:right");
    // In the gap between clusters: the nearer one's.
    expect(edgeNear(edges, { x: 1215, y: 100 }, 24)?.key).toBe("d:right");
    expect(edgeNear(edges, { x: 1300, y: 100 }, 24)?.key).toBe("e:left");
  });

  test("none in the middle of a frame, or beyond an edge's extent", () => {
    const edges = insertEdges(frames);
    expect(edgeNear(edges, { x: 200, y: 100 }, 24)).toBeNull();
    expect(edgeNear(edges, { x: 1320, y: 400 }, 24)).toBeNull();
    expect(edgeNear(edges, { x: 400, y: -10 }, 24)).toBeNull();
  });

  test("the reach is in board px: zoomed out, it is wider", () => {
    const edges = insertEdges(frames);
    expect(edgeNear(edges, { x: 300, y: 100 }, 24)).toBeNull();
    expect(edgeNear(edges, { x: 300, y: 100 }, 24 / 0.1)?.key).toBe("a:right");
  });
});
