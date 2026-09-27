import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import {
  boundIds,
  checkSkeletons,
  describeDrawing,
  drawChanges,
  drawingOf,
  mergeElements,
  readElements,
  restingView,
  route,
  routeArrows,
  writeElements,
  type DrawingElement,
} from "./drawing";

let n = 0;
const el = (patch: Partial<DrawingElement> & { id: string }): DrawingElement => ({
  type: "rectangle",
  version: 1,
  versionNonce: ++n,
  index: `a${n}`,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...patch,
});

describe("writeElements", () => {
  test("writes only what is newer than the doc, as copies", () => {
    const doc = new Y.Doc();
    const a = { ...el({ id: "a" }), points: [[0, 0]] };
    expect(writeElements(doc, "f", [a])).toBe(1);
    expect(writeElements(doc, "f", [a])).toBe(0);
    // Excalidraw changes elements in place: the doc keeps what was sent.
    (a.points[0] as number[])[0] = 99;
    expect((drawingOf(doc, "f").get("a")!.points as number[][])[0]![0]).toBe(0);
    expect(writeElements(doc, "f", [{ ...a, version: 2 }])).toBe(1);
    expect(drawingOf(doc, "f").get("a")!.version).toBe(2);
  });

  test("keeps images local, and marks its writes with the origin", () => {
    const doc = new Y.Doc();
    let origin: unknown;
    doc.on("update", (_: Uint8Array, o: unknown) => (origin = o));
    const mine = Symbol("editor");
    writeElements(doc, "f", [el({ id: "a" }), el({ id: "i", type: "image" })], mine);
    expect([...drawingOf(doc, "f").keys()]).toEqual(["a"]);
    expect(origin).toBe(mine);
  });
});

describe("mergeElements", () => {
  test("takes the doc's element unless ours is newer", () => {
    const ours = [el({ id: "a", version: 3 }), el({ id: "b", version: 1 })];
    const merged = mergeElements(ours, [
      el({ id: "a", version: 2, x: 5 }),
      el({ id: "b", version: 2, x: 7 }),
      el({ id: "c" }),
    ])!;
    expect(merged.map((e) => [e.id, e.x]).sort()).toEqual([
      ["a", 0],
      ["b", 7],
      ["c", 0],
    ]);
  });

  test("settles equal versions by the doc's, and says when nothing changed", () => {
    const a = el({ id: "a", version: 2 });
    expect(mergeElements([a], [a])).toBeNull();
    const theirs = { ...a, versionNonce: a.versionNonce + 1, x: 9 };
    expect(mergeElements([a], [theirs])![0]!.x).toBe(9);
  });

  test("stacks by index, then id", () => {
    const merged = mergeElements(
      [el({ id: "b", index: "a1" })],
      [el({ id: "a", index: "a1" }), el({ id: "c", index: "a0" })],
    )!;
    expect(merged.map((e) => e.id)).toEqual(["c", "a", "b"]);
  });
});

describe("checkSkeletons", () => {
  test("accepts the kinds agents draw, and refuses the rest", () => {
    expect(checkSkeletons([{ type: "rectangle", x: 0, y: 0 }])).toHaveLength(1);
    expect(() => checkSkeletons([{ type: "image", x: 0, y: 0 }])).toThrow(/type must be one of/);
    expect(() => checkSkeletons([{ type: "embeddable", x: 0, y: 0 }])).toThrow(/type must/);
    expect(() => checkSkeletons([{ type: "text", x: 0, y: 0 }])).toThrow(/needs text/);
    expect(() => checkSkeletons([{ type: "ellipse", x: "left", y: 0 }])).toThrow(
      /needs numbers x and y, got x "left"/,
    );
    expect(() => checkSkeletons([{ type: "arrow", x: 0, y: 0, start: { type: "image" } }])).toThrow(
      /start.type/,
    );
    expect(() => checkSkeletons({ type: "rectangle" })).toThrow(/list/);
  });

  test("reads numbers and JSON that models send as strings", () => {
    const [shape] = checkSkeletons(
      JSON.stringify([
        { type: "ellipse", x: "465", y: "816", width: "110", label: '{"text":"you"}' },
      ]),
    );
    expect(shape).toMatchObject({ x: 465, y: 816, width: 110, label: { text: "you" } });
  });

  test("an arrow between two shapes needs no place of its own", () => {
    const [arrow] = checkSkeletons([{ type: "arrow", start: { id: "a" }, end: { id: "b" } }]);
    expect(arrow).toMatchObject({ x: 0, y: 0 });
    expect(() => checkSkeletons([{ type: "arrow", start: { id: "a" } }])).toThrow(/x and y/);
  });
});

describe("arrows", () => {
  test("boundIds names the shapes drawn before that arrows bind to", () => {
    const skeletons = [
      { type: "rectangle", id: "new", x: 0, y: 0 },
      { type: "arrow", x: 0, y: 0, start: { id: "old" }, end: { id: "new" } },
      { type: "arrow", x: 0, y: 0, start: { type: "ellipse" }, end: { id: "old" } },
    ];
    expect(boundIds(skeletons)).toEqual(["old"]);
  });

  test("route goes from outline to outline, with a gap", () => {
    const from = { type: "rectangle", x: 0, y: 0, width: 100, height: 50 };
    const to = { type: "ellipse", x: 300, y: 0, width: 100, height: 50 };
    const { x, y, points } = route(from, to);
    expect([x, y]).toEqual([108, 25]);
    expect(points).toEqual([
      [0, 0],
      [184, 0],
    ]);
  });

  test("routeArrows routes arrows between known shapes, unless given points", () => {
    const drawn = [el({ id: "old", x: 0, y: 0, width: 100, height: 100 })];
    const [shape, routed, given] = routeArrows(
      [
        { type: "rectangle", id: "new", x: 0, y: 300, width: 100, height: 100 },
        { type: "arrow", x: 0, y: 0, start: { id: "old" }, end: { id: "new" } },
        {
          type: "arrow",
          x: 5,
          y: 5,
          points: [
            [0, 0],
            [1, 1],
          ],
          start: { id: "old" },
          end: { id: "new" },
        },
      ],
      drawn,
    );
    expect(shape!.x).toBe(0);
    expect(routed).toMatchObject({
      x: 50,
      y: 108,
      points: [
        [0, 0],
        [0, 184],
      ],
    });
    expect(given).toMatchObject({
      x: 5,
      points: [
        [0, 0],
        [1, 1],
      ],
    });
  });
});

describe("drawChanges", () => {
  const current = [
    el({ id: "box", index: "a0", boundElements: [{ id: "old-arrow", type: "arrow" }] }),
    el({ id: "label", type: "text", index: "a1", containerId: "box", text: "hi" }),
    el({ id: "gone", index: "a2", isDeleted: true }),
  ];

  test("adds on top, in order", () => {
    const { write, added } = drawChanges(current, {
      add: [el({ id: "n1", index: "a0" }), el({ id: "n2", index: "a1" })],
    });
    expect(added).toBe(2);
    const [i1, i2] = write.map((e) => e.index!);
    expect(i1! > "a2" && i2! > i1!).toBe(true);
  });

  test("replaces an element in its place, newer, keeping its arrows", () => {
    const { write, replaced } = drawChanges(current, {
      add: [
        el({ id: "box", version: 1, x: 40, boundElements: [{ id: "new-arrow", type: "arrow" }] }),
      ],
    });
    expect(replaced).toBe(1);
    expect(write[0]).toMatchObject({ id: "box", x: 40, index: "a0", version: 2 });
    expect(write[0]!.boundElements!.map((b) => b.id)).toEqual(["old-arrow", "new-arrow"]);
  });

  test("removes elements with their labels, and refuses unknown ones", () => {
    const { write, removed } = drawChanges(current, { remove: ["box"] });
    expect(removed).toBe(2);
    expect(write.every((e) => e.isDeleted && e.version === 2)).toBe(true);
    expect(() => drawChanges(current, { remove: ["gone"] })).toThrow(/no element gone/);
  });

  test("clear removes everything there", () => {
    expect(drawChanges(current, { clear: true }).removed).toBe(2);
  });
});

describe("describeDrawing", () => {
  test("lists shapes with labels, what arrows connect, and counts strokes", () => {
    const lines = describeDrawing([
      el({ id: "a", x: 0, y: 0, width: 100, height: 50 }),
      el({ id: "at", type: "text", containerId: "a", text: "canvas serve" }),
      el({ id: "b", type: "ellipse", x: 300, y: 0, width: 80, height: 40 }),
      el({
        id: "c",
        type: "arrow",
        x: 108,
        y: 25,
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
      el({ id: "t", type: "text", x: 0, y: 200, text: "note", link: "src/a.ts" }),
      el({ id: "f1", type: "freedraw" }),
      el({ id: "f2", type: "freedraw" }),
      el({ id: "x", isDeleted: true }),
    ]);
    expect(lines[0]).toStartWith("7 elements, within x 0…380");
    expect(lines).toContain('- rectangle a "canvas serve" at 0,0 100×50');
    expect(lines).toContain("- ellipse b at 300,0 80×40");
    expect(lines).toContain('- arrow c from a "canvas serve" to b at 108,25');
    expect(lines).toContain('- text t "note" at 0,200 link src/a.ts');
    expect(lines).toContain("- 2 freehand strokes");
  });

  test("says when it is empty", () => {
    expect(describeDrawing([el({ id: "x", isDeleted: true })])).toEqual(["The drawing is empty."]);
  });
});

describe("restingView", () => {
  test("fits the content, never enlarged, centred; the editor's scroll matches", () => {
    const small = restingView({ x: 100, y: 100, w: 200, h: 100 }, 10, 800, 600);
    expect(small).toMatchObject({ zoom: 1, width: 220, height: 120, left: 290, top: 240 });
    // Excalidraw puts the content's corner (minus padding) at (corner + scroll) × zoom.
    expect((90 + small.scrollX) * small.zoom).toBe(small.left);
    const big = restingView({ x: 0, y: 0, w: 1580, h: 380 }, 10, 800, 600);
    expect(big.zoom).toBe(0.5);
    expect((-10 + big.scrollY) * big.zoom).toBe(big.top);
  });

  test("an empty drawing sits at the origin", () => {
    expect(restingView(null, 10, 800, 600)).toMatchObject({ zoom: 1, scrollX: 0, scrollY: 0 });
  });
});

test("readElements reads the frame's own map", () => {
  const doc = new Y.Doc();
  writeElements(doc, "f", [el({ id: "a" })]);
  expect(readElements(doc, "f").map((e) => e.id)).toEqual(["a"]);
  expect(readElements(doc, "g")).toEqual([]);
});
