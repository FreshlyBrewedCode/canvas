import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { addFrame, removeFrame } from "./board";
import {
  addComment,
  editComment,
  mayChange,
  readComments,
  removeComment,
  settle,
  type Comment,
} from "./comments";

const karl = { kind: "person", id: "k", name: "Karl", color: "#f97316" } as const;
const ada = { kind: "person", id: "a", name: "Ada", color: "#3b82f6" } as const;
const claude = { kind: "agent", frame: "f1", name: "claude-1" } as const;

function board() {
  const doc = new Y.Doc();
  const frame = addFrame(doc, { type: "file", path: "a.ts", title: "a.ts" });
  const add = (comment: Partial<Comment> = {}) =>
    addComment(doc, frame, {
      path: "a.ts",
      start: 2,
      end: 2,
      quote: "b",
      body: "why?",
      author: karl,
      ...comment,
    });
  return { doc, frame, add, all: () => readComments(doc, frame) };
}

describe("comments", () => {
  test("add, edit, remove; sorted by file and line", () => {
    const { doc, frame, add, all } = board();
    const second = add({ path: "b.ts" });
    const first = add({ start: 1, end: 1, quote: "a" });
    expect(all().map((c) => c.id)).toEqual([first.id, second.id]);
    editComment(doc, frame, first.id, "fixed");
    expect(all()[0]).toMatchObject({ body: "fixed", edited: expect.any(Number) });
    removeComment(doc, frame, first.id);
    expect(all().map((c) => c.id)).toEqual([second.id]);
  });

  test("go with their frame", () => {
    const { doc, frame, add, all } = board();
    add();
    removeFrame(doc, frame);
    expect(all()).toEqual([]);
  });

  test("settle follows moved lines, marks gone ones outdated, and back", () => {
    const { doc, frame, add, all } = board();
    add();
    add({ path: "b.ts" });
    settle(doc, frame, "a.ts", "new\na\nb\n");
    expect(all()[0]).toMatchObject({ start: 3, end: 3 });
    expect(all()[0]!.outdated).toBeUndefined();
    settle(doc, frame, "a.ts", "a\nc\n");
    expect(all()[0]).toMatchObject({ start: 3, outdated: true });
    settle(doc, frame, "a.ts", "b\n");
    expect(all()[0]).toMatchObject({ start: 1, end: 1 });
    expect(all()[0]!.outdated).toBeUndefined();
    expect(all()[1]).toMatchObject({ path: "b.ts", start: 2 });
  });

  test("settle writes nothing when nothing moved", () => {
    const { doc, frame, add } = board();
    add();
    let updates = 0;
    doc.on("update", () => updates++);
    settle(doc, frame, "a.ts", "a\nb\n");
    expect(updates).toBe(0);
  });

  test("people change their own, the host everyone's, agents only agents'", () => {
    const { add } = board();
    const mine = add();
    const hers = add({ author: ada });
    const agents = add({ author: claude });
    const me = { kind: "person", id: "k", host: false } as const;
    expect(mayChange(me, mine)).toBe(true);
    expect(mayChange(me, hers)).toBe(false);
    expect(mayChange(me, agents)).toBe(false);
    const host = { kind: "person", id: "h", host: true } as const;
    expect([mine, hers, agents].every((c) => mayChange(host, c))).toBe(true);
    const agent = { kind: "agent" } as const;
    expect(mayChange(agent, agents)).toBe(true);
    expect(mayChange(agent, mine)).toBe(false);
  });
});
