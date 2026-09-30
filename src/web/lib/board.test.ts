import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { GAP } from "../../shared/layout";
import {
  addFrame,
  allFrames,
  boardLayout,
  framesOf,
  layoutOf,
  moveFrame,
  readFrame,
  removeFrame,
  tidy,
  type Frame,
} from "./board";
import { placeFrames, type Placed } from "./test-board";

const file = (x: number, y: number, w = 600, h = 400): Placed => ({
  type: "file",
  path: "a.ts",
  title: "a.ts",
  x,
  y,
  w,
  h,
});
const at = (doc: Y.Doc, id: string) => {
  const { x, y, w, h } = allFrames(doc).find((f) => f.id === id)!;
  return { x, y, w, h };
};

describe("readFrame", () => {
  test("reads a markdown frame from an older board as a file frame", () => {
    const doc = new Y.Doc();
    const [id] = placeFrames(doc, [
      { type: "markdown", path: "docs/plan.md", title: "plan", x: 0, y: 0, w: 480, h: 560 },
    ] as never);
    expect(readFrame(framesOf(doc).get(id!)!, id!)).toMatchObject({
      id,
      type: "file",
      path: "docs/plan.md",
    });
  });
});

describe("the board on the tree", () => {
  test("a board from before is migrated: its clusters and rows, positions derived", () => {
    const doc = new Y.Doc();
    const [a, b, c, far] = placeFrames(doc, [
      file(0, 0),
      file(624, 0, 500),
      file(0, 424, 700, 300),
      file(5000, 5000),
    ]);
    expect(at(doc, a!)).toEqual({ x: 0, y: 0, w: 600, h: 400 });
    expect(at(doc, b!)).toEqual({ x: 600 + GAP, y: 0, w: 500, h: 400 });
    expect(at(doc, c!)).toEqual({ x: 0, y: 400 + GAP, w: 700, h: 300 });
    expect(allFrames(doc).find((f) => f.id === far)!.cluster).not.toBe(
      allFrames(doc).find((f) => f.id === a)!.cluster,
    );
    const stored = framesOf(doc).get(a!)!.toJSON();
    expect(["x", "y", "w", "h"].filter((key) => key in stored)).toEqual([]);
    expect(tidy(doc)).toBe(false);
  });

  test("frames are added, moved and removed by the tree's operations", () => {
    const doc = new Y.Doc();
    const a = addFrame(doc, { type: "file", path: "a.ts", title: "a" });
    const b = addFrame(doc, { type: "terminal", title: "t" }, { anchor: a, side: "right" });
    const c = addFrame(doc, { type: "drawing", title: "d" }, { anchor: a, side: "below" });
    const frame = (id: string) => allFrames(doc).find((f) => f.id === id) as Frame;
    expect(frame(b)).toMatchObject({ x: 720 + GAP, y: 0, h: 560, row: frame(a).row });
    expect(frame(c)).toMatchObject({ x: 0, y: 560 + GAP, cluster: frame(a).cluster });

    moveFrame(doc, c, { anchor: a, side: "left" });
    expect(frame(c)).toMatchObject({ x: 0, y: 0, row: frame(a).row });
    expect(frame(a).x).toBe(960 + GAP);

    removeFrame(doc, c);
    expect(frame(a).x).toBe(0);
    expect(boardLayout(doc).empty.length).toBeGreaterThan(0);
    expect(tidy(doc)).toBe(true);
    expect(boardLayout(doc).empty).toEqual([]);
    // One line, one cluster, one row, two columns.
    expect(layoutOf(doc).size).toBe(5);
  });

  test("a new frame is a cluster of its own at the end by default", () => {
    const doc = new Y.Doc();
    const a = addFrame(doc, { type: "file", path: "a.ts", title: "a" });
    const b = addFrame(doc, { type: "file", path: "b.ts", title: "b" });
    const [fa, fb] = [a, b].map((id) => allFrames(doc).find((f) => f.id === id)!);
    expect(fa!.cluster).not.toBe(fb!.cluster);
    expect(fb!.x).toBeGreaterThan(fa!.x + fa!.w);
  });
});

describe("terminals", () => {
  test("the host gives a terminal without a height its share of the host's screen", () => {
    const doc = new Y.Doc();
    const t = addFrame(doc, { type: "terminal", title: "shell" });
    tidy(doc, { screen: 900 });
    expect(allFrames(doc).find((f) => f.id === t)!.height).toBe(450);
    // What someone set stays.
    framesOf(doc).get(t)!.set("height", 300);
    tidy(doc, { screen: 1200 });
    expect(allFrames(doc).find((f) => f.id === t)!.height).toBe(300);
  });
});
