import { expect, test } from "bun:test";

import type { AgentEvent, SessionMeta } from "./protocol";
import { isSessionId, lastFrame } from "./sessions";

const author = { name: "Ada", color: "#000" };

test("session ids are names, never paths", () => {
  expect(isSessionId("1a2b3c4d")).toBe(true);
  expect(isSessionId("0b9e6b3c-1f2a-4c1e-9a7b-2a1d3c4e5f60")).toBe(true);
  for (const id of ["", "../x", "a/b", "a.b", "x".repeat(65), 7, null])
    expect(isSessionId(id)).toBe(false);
});

test("the agent acts as its last turn's frame, else where it began", () => {
  const meta: SessionMeta = {
    id: "s1",
    agent: "claude",
    status: "idle",
    frameId: "f1",
    createdAt: 0,
    lastAt: 0,
  };
  expect(lastFrame(meta, [])).toBe("f1");
  const events: AgentEvent[] = [
    { kind: "turn", turnId: "a", text: "x", author, at: 1, frameId: "f2" },
    { kind: "turn-end", turnId: "a" },
    { kind: "turn", turnId: "b", text: "x", author, at: 2 },
  ];
  expect(lastFrame(meta, events)).toBe("f2");
});
