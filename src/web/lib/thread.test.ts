import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { AgentEvent } from "../../shared/protocol";
import { foldThread, groupSteps, latestPlan, type Row } from "./thread";

/** A real opencode session: one turn, three shell permissions approved by the host. */
const corpus = readFileSync(
  new URL("../../test/corpus/opencode-permissions.ndjson", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { event?: AgentEvent })
  .flatMap((record) => (record.event ? [record.event] : []));

describe("foldThread", () => {
  test("folds a recorded session into one finished turn", () => {
    const [turn, ...rest] = foldThread(corpus);
    expect(rest).toHaveLength(0);
    expect(turn!.author.name).toBe("Ada");
    expect(turn!.end).toEqual({ error: undefined, cancelled: undefined });
    expect(
      turn!.rows.some((row) => row.kind === "text" && row.content.includes("docs/plan.md")),
    ).toBe(true);
    const tools = turn!.rows.filter((row) => row.kind === "tool");
    expect(tools.length).toBeGreaterThan(3);
    expect(tools.every((row) => row.kind === "tool" && row.result !== undefined)).toBe(true);
  });

  test("keeps permissions and who resolved them", () => {
    const [turn] = foldThread(corpus);
    // This recording predates `toolCallId` on permission events: they stay turn-level.
    expect(turn!.permissions).toHaveLength(3);
    expect(
      turn!.permissions.every((p) => p.resolved?.by === "Karl" && p.resolved.optionId === "once"),
    ).toBe(true);
  });

  test("row keys are deterministic, so selections resolve on every peer", () => {
    const keys = (events: AgentEvent[]) =>
      foldThread(events).flatMap((t) => t.rows.map((r) => r.key));
    expect(keys(corpus)).toEqual(keys(structuredClone(corpus)));
  });

  test("a permission with a tool call id is shown with that call", () => {
    const events: AgentEvent[] = [
      { kind: "turn", turnId: "t", text: "run it", author: { name: "a", color: "#000" }, at: 0 },
      {
        kind: "chunk",
        turnId: "t",
        chunk: { type: "RUN_STARTED", runId: "r", threadId: "x", timestamp: 0 },
      },
      {
        kind: "chunk",
        turnId: "t",
        chunk: {
          type: "TOOL_CALL_START",
          toolCallId: "c1",
          toolCallName: "execute",
          toolName: "execute",
          timestamp: 0,
        },
      },
      {
        kind: "chunk",
        turnId: "t",
        chunk: { type: "TOOL_CALL_END", toolCallId: "c1", toolName: "execute", timestamp: 0 },
      },
      {
        kind: "permission",
        turnId: "t",
        requestId: "p1",
        toolCallId: "c1",
        title: "ls",
        options: [],
      },
    ];
    const [turn] = foldThread(events);
    const tool = turn!.rows.find((row) => row.kind === "tool");
    expect(tool?.kind === "tool" && tool.permissions.map((p) => p.requestId)).toEqual(["p1"]);
    expect(turn!.permissions).toHaveLength(0);
  });
});

describe("latestPlan", () => {
  const plan = (turnId: string, ...statuses: Array<"pending" | "in_progress" | "completed">) =>
    ({
      kind: "chunk",
      turnId,
      chunk: {
        type: "CUSTOM",
        name: "plan",
        value: { entries: statuses.map((status, i) => ({ content: `step ${i}`, status })) },
      },
    }) satisfies AgentEvent;
  const turn = (turnId: string): AgentEvent => ({
    kind: "turn",
    turnId,
    text: "go",
    author: { name: "a", color: "#000" },
    at: 0,
  });

  test("none until the agent sends one", () => {
    expect(latestPlan(corpus)).toBeNull();
  });

  test("the last one wins, across turns", () => {
    const events: AgentEvent[] = [
      turn("t1"),
      plan("t1", "in_progress", "pending"),
      plan("t1", "completed", "in_progress"),
      { kind: "turn-end", turnId: "t1" },
      turn("t2"),
    ];
    expect(latestPlan(events)?.map((e) => e.status)).toEqual(["completed", "in_progress"]);
    events.push(plan("t2", "pending"));
    expect(latestPlan(events)).toEqual([{ content: "step 0", status: "pending" }]);
  });

  test("other custom chunks are not plans", () => {
    const other = { kind: "chunk", turnId: "t", chunk: { type: "CUSTOM", name: "x.session-id" } };
    expect(latestPlan([turn("t"), other as AgentEvent])).toBeNull();
  });
});

describe("groupSteps", () => {
  const text = (key: string): Row => ({ kind: "text", key, content: key });
  const thinking = (key: string): Row => ({ kind: "thinking", key, content: key });
  const tool = (key: string, waiting = false): Row => ({
    kind: "tool",
    key,
    name: "read",
    args: "{}",
    state: "input-complete",
    result: "ok",
    isError: false,
    permissions: waiting
      ? [{ requestId: "r", title: "t", options: [], resolved: null }]
      : [{ requestId: "r", title: "t", options: [], resolved: { optionId: "o", by: "Karl" } }],
  });
  const shape = (rows: Row[]) =>
    groupSteps(rows).map((item) =>
      item.kind === "steps" ? `[${item.rows.map((r) => r.key).join(" ")}]` : item.key,
    );

  test("runs of two tool calls or more fold, reasoning with them", () => {
    expect(shape([text("a"), tool("1"), thinking("r"), tool("2"), tool("3"), text("b")])).toEqual([
      "a",
      "[1 r 2 3]",
      "b",
    ]);
  });

  test("a lone tool call stays as it is", () => {
    expect(shape([thinking("r"), tool("1"), text("b"), tool("2")])).toEqual(["r", "1", "b", "2"]);
  });

  test("a call waiting on a permission breaks the run and shows", () => {
    expect(shape([tool("1"), tool("2"), tool("3", true), tool("4")])).toEqual(["[1 2]", "3", "4"]);
  });
});
