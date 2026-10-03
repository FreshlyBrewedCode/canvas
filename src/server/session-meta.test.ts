import { expect, test } from "bun:test";
import type { AgentEvent } from "../shared/protocol";
import { lastFrame, newMeta, sessionTitle, withDefaults } from "./session-meta";

const author = { name: "Ada", color: "#000" };

test("a title is the first line with text, cut at a word", () => {
  expect(sessionTitle("\n  \n  Fix   the login\nand more")).toBe("Fix the login");
  expect(sessionTitle("   \n")).toBeUndefined();
  const long = "Explain how the board's layout tree resolves rects for clusters and rows please";
  const title = sessionTitle(long, 40)!;
  expect(title).toBe("Explain how the board's layout tree…");
  expect(title.length).toBeLessThanOrEqual(40);
  expect(sessionTitle("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
});

test("a new session begins in its frame, now, with no title", () => {
  expect(newMeta("s1", { frameId: "f1", agent: "claude" }, 5)).toEqual({
    id: "s1",
    agent: "claude",
    status: "idle",
    frameId: "f1",
    createdAt: 5,
    lastAt: 5,
  });
});

test("a log from before ADR 0012 began in the frame of its id, at its first turn", () => {
  const events: AgentEvent[] = [
    { kind: "turn", turnId: "t1", text: "hello there", author, at: 10 },
    { kind: "turn-end", turnId: "t1", at: 20 },
    { kind: "turn", turnId: "t2", text: "again", author, at: 30 },
    { kind: "turn-end", turnId: "t2" },
  ];
  expect(withDefaults({ id: "f1", agent: "claude", status: "idle" }, events, 99)).toEqual({
    id: "f1",
    agent: "claude",
    status: "idle",
    frameId: "f1",
    createdAt: 10,
    lastAt: 30,
    title: "hello there",
  });
  // Nothing to go by: the fallback, and no title.
  expect(withDefaults({ id: "f2", agent: "claude", status: "idle" }, [], 99)).toEqual({
    id: "f2",
    agent: "claude",
    status: "idle",
    frameId: "f2",
    createdAt: 99,
    lastAt: 99,
  });
});

test("what a meta says stays", () => {
  const meta = {
    ...newMeta("s1", { frameId: "f1", agent: "claude" }, 5),
    title: "kept",
  };
  const events: AgentEvent[] = [{ kind: "turn", turnId: "t", text: "other", author, at: 7 }];
  expect(withDefaults(meta, events, 99)).toEqual(meta);
});

test("the agent acts as its last turn's frame, else where it began", () => {
  const meta = newMeta("s1", { frameId: "f1", agent: "claude" }, 0);
  expect(lastFrame(meta, [])).toBe("f1");
  const events: AgentEvent[] = [
    { kind: "turn", turnId: "a", text: "x", author, at: 1, frameId: "f2" },
    { kind: "turn-end", turnId: "a" },
    { kind: "turn", turnId: "b", text: "x", author, at: 2 },
  ];
  expect(lastFrame(meta, events)).toBe("f2");
});
