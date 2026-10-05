import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { allFrames, type NewFrame } from "./board";
import { addComment } from "./comments";
import { navigate, type NavigateContext } from "./navigate";
import { pendingReveal } from "./reveal";
import { placeFrames, type Placed } from "./test-board";

const OWN = "own-runtime";

function board(canEdit = true) {
  const doc = new Y.Doc();
  const focused: string[] = [];
  const fitted: string[] = [];
  const ctx: NavigateContext = {
    doc,
    runtime: OWN,
    canEdit,
    focus: (id) => focused.push(id),
    fit: (box) => fitted.push(`${box.x},${box.y}`),
  };
  /** Frames by position, each a cluster of its own unless placed together. */
  const place = (...frames: Array<Partial<Placed> & { type: NewFrame["type"] }>) =>
    placeFrames(
      doc,
      frames.map((frame) => ({ title: "t", x: 0, y: 0, w: 400, h: 300, ...frame }) as Placed),
    );
  const add = (frame: Partial<Placed> & { type: NewFrame["type"] }) => place(frame)[0]!;
  const frame = (id: string) =>
    allFrames(doc).find((f) => f.id === id) as unknown as Record<string, unknown>;
  return { doc, ctx, focused, fitted, add, place, frame };
}

describe("navigate", () => {
  test("to a frame: our view and focus move, the board doesn't", () => {
    const { ctx, focused, fitted, add, frame } = board();
    add({ type: "file", path: "src/z.ts" });
    const id = add({ type: "file", path: "src/a.ts" });
    const before = JSON.stringify(frame(id));
    expect(navigate(ctx, { frame: id })).toEqual({ frame: id });
    expect(focused).toEqual([id]);
    expect(fitted).toEqual([`${frame(id).x},${frame(id).y}`]);
    expect(frame(id).x).toBeGreaterThan(400);
    expect({ ...frame(id), z: 0 }).toEqual({ ...JSON.parse(before), z: 0 });
  });

  test("lines of a file a frame shows: ours to see, the frame keeps its own", () => {
    const { ctx, add, frame } = board();
    const id = add({ type: "file", path: "src/a.ts" });
    navigate(ctx, { path: "src/a.ts", lines: { start: 3, end: 5 } });
    expect(frame(id).lines).toBeUndefined();
    expect(pendingReveal(id)).toMatchObject({ path: "src/a.ts", lines: { start: 3, end: 5 } });
  });

  test("lines of a markdown file in preview put the frame in source", () => {
    const { ctx, add, frame } = board();
    const id = add({ type: "file", path: "docs/a.md" });
    navigate(ctx, { frame: id, lines: { start: 2, end: 2 }, path: "docs/a.md" });
    expect(frame(id).view).toBe("source");
  });

  test("the nearest frame that shows the file", () => {
    const { ctx, place } = board();
    const [from, , near] = place(
      { type: "agent", agent: "claude", x: 0 },
      { type: "file", path: "src/a.ts", x: 5000, y: 3000 },
      { type: "file", path: "src/a.ts", x: 500 },
    );
    expect(navigate(ctx, { path: "src/a.ts" }, { from })?.frame).toBe(near);
  });

  test("a file no frame shows opens beside the link's frame", () => {
    const { doc, ctx, add, frame } = board();
    const from = add({ type: "agent", agent: "claude" });
    const where = navigate(ctx, { path: "src/b.ts", lines: { start: 7, end: 7 } }, { from });
    expect(allFrames(doc)).toHaveLength(2);
    expect(frame(where!.frame!)).toMatchObject({
      type: "file",
      path: "src/b.ts",
      title: "b.ts",
      view: "source",
      x: expect.any(Number),
    });
    expect(frame(where!.frame!).x as number).toBeGreaterThanOrEqual(400);
    expect(frame(where!.frame!).lines).toBeUndefined();
  });

  test("view guests go to frames, but open none", () => {
    const { doc, ctx, add } = board(false);
    const id = add({ type: "file", path: "src/a.ts" });
    expect(navigate(ctx, { path: "src/b.ts" })).toBeNull();
    expect(navigate(ctx, { path: "src/a.ts" })?.frame).toBe(id);
    expect(allFrames(doc)).toHaveLength(1);
  });

  test("a page's link to another page opens in its own frame", () => {
    const { doc, ctx, add, frame } = board();
    const page = add({ type: "file", path: "canvas:scratch/index.html" });
    add({ type: "file", path: "canvas:scratch/two.html", x: 900 });
    navigate(ctx, { path: "canvas:scratch/two.html" }, { from: page, inPlace: true });
    expect(frame(page)).toMatchObject({ path: "canvas:scratch/two.html", title: "two.html" });
    expect(allFrames(doc)).toHaveLength(2);
  });

  test("a comment: its file, at its lines", () => {
    const { doc, ctx, add, frame } = board();
    const id = add({ type: "file", path: "src/a.ts" });
    const comment = addComment(doc, id, {
      path: "src/b.ts",
      start: 4,
      end: 6,
      quote: "x",
      body: "look",
      author: { kind: "agent", frame: "f", name: "agent" },
    });
    const where = navigate(ctx, { frame: id, comment: comment.id });
    expect(frame(id)).toMatchObject({ path: "src/b.ts", view: "source" });
    expect(where).toEqual({
      frame: id,
      path: "src/b.ts",
      lines: { start: 4, end: 6 },
      comment: comment.id,
    });
  });

  test("a closed frame goes nowhere", () => {
    const { ctx } = board();
    expect(navigate(ctx, { frame: "gone" })).toBeNull();
  });
});

describe("navigate, deep links", () => {
  test("lines of a frame, without a path: of the file it shows", () => {
    const { ctx, add } = board();
    const id = add({ type: "file", path: "src/a.ts" });
    expect(navigate(ctx, { frame: id, lines: { start: 30, end: 33 } })).toEqual({
      frame: id,
      path: "src/a.ts",
      lines: { start: 30, end: 33 },
    });
    expect(pendingReveal(id)).toMatchObject({ path: "src/a.ts", lines: { start: 30, end: 33 } });
  });
});

describe("navigate, by address (ADR 0013)", () => {
  test("wherever the path shows means a frame with the whole address", () => {
    const { ctx, add, frame, doc } = board();
    const here = add({ type: "file", path: "src/a.ts" });
    const there = add({ type: "file", path: "src/a.ts", runtime: "laptop-2" } as never);
    expect(navigate(ctx, { path: "src/a.ts", runtime: "laptop-2" })?.frame).toBe(there);
    expect(navigate(ctx, { path: "src/a.ts" })?.frame).toBe(here);
    // The own runtime's id written out is the same runtime.
    expect(navigate(ctx, { path: "src/a.ts", runtime: OWN })).toEqual({
      frame: here,
      path: "src/a.ts",
    });
    // Elsewhere, and no frame shows it: a new one, at that address.
    const where = navigate(ctx, { path: "src/b.ts", root: "worktree-1" });
    expect(frame(where!.frame!)).toMatchObject({ path: "src/b.ts", root: "worktree-1" });
    expect(where).toEqual({ frame: where!.frame, root: "worktree-1", path: "src/b.ts" });
    expect(allFrames(doc)).toHaveLength(3);
  });

  test("a frame pointed at a file of the own runtime leaves no address behind", () => {
    const { ctx, add, frame } = board();
    const id = add({ type: "file", path: "src/a.ts", runtime: "laptop-2", root: "r" } as never);
    navigate(ctx, { frame: id, path: "src/b.ts" });
    expect(frame(id).path).toBe("src/b.ts");
    expect("runtime" in frame(id) || "root" in frame(id)).toBe(false);
    navigate(ctx, { frame: id, path: "src/b.ts", runtime: "laptop-3" });
    expect(frame(id)).toMatchObject({ path: "src/b.ts", runtime: "laptop-3" });
  });

  test("a comment's file is at its address", () => {
    const { ctx, add, frame, doc } = board();
    const id = add({ type: "file", path: "src/a.ts" });
    const comment = addComment(doc, id, {
      runtime: "laptop-2",
      path: "src/b.ts",
      start: 4,
      end: 6,
      quote: "x",
      body: "look",
      author: { kind: "agent", frame: "f", name: "agent" },
    });
    navigate(ctx, { frame: id, comment: comment.id });
    expect(frame(id)).toMatchObject({ runtime: "laptop-2", path: "src/b.ts" });
  });
});
