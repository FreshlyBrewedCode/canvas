import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { AgentEvent } from "../../shared/protocol";
import { foldThread } from "./thread";

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
