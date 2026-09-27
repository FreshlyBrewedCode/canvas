import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentEvent } from "../shared/protocol";
import { foldThread } from "../web/lib/thread";
import { TOOL_TEXT_LIMIT, trimEvent } from "./trim-event";

const chunk = (value: Record<string, unknown>): AgentEvent => ({
  kind: "chunk",
  turnId: "t",
  chunk: { model: "claude", timestamp: 1, ...value },
});
const chunkOf = (event: AgentEvent) => (event as Extract<AgentEvent, { kind: "chunk" }>).chunk;

test("a text chunk keeps its delta, not the message so far", () => {
  const event = chunk({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m",
    delta: " world",
    content: "hello world",
  });
  expect(chunkOf(trimEvent(event))).toEqual({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m",
    model: "claude",
    timestamp: 1,
    delta: " world",
  });
});

test("a thread folds the same without the repeated text", () => {
  const events: AgentEvent[] = [
    { kind: "turn", turnId: "t", text: "hi", author: { name: "a", color: "#000" }, at: 0 },
    chunk({ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" }),
    chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hello", content: "hello" }),
    chunk({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m",
      delta: " world",
      content: "hello world",
    }),
    chunk({ type: "TEXT_MESSAGE_END", messageId: "m" }),
    { kind: "turn-end", turnId: "t" },
  ];
  expect(foldThread(events.map(trimEvent))).toEqual(foldThread(events));
  expect(foldThread(events.map(trimEvent))[0]?.rows).toMatchObject([{ content: "hello world" }]);
});

test("images in tool output become a placeholder with their size", () => {
  const data = "A".repeat(200_000);
  const content = JSON.stringify([
    { type: "image", source: { type: "base64", data, media_type: "image/png" } },
    { type: "text", text: "a screenshot" },
  ]);
  const event = chunk({ type: "TOOL_CALL_RESULT", toolCallId: "c", content });
  const trimmed = chunkOf(trimEvent(event)) as { content: string };
  expect(JSON.parse(trimmed.content)).toEqual([
    { type: "image", omitted: "195 KB" },
    { type: "text", text: "a screenshot" },
  ]);
});

test("image attachments as data URLs (opencode's) become a placeholder too", () => {
  const url = `data:image/png;base64,${"A".repeat(20_000)}`;
  const output = { output: "a drawing", attachments: [{ type: "file", mime: "image/png", url }] };
  const trimmed = trimEvent(
    chunk({ type: "TOOL_CALL_RESULT", toolCallId: "c", content: JSON.stringify(output) }),
  );
  expect(JSON.parse((chunkOf(trimmed) as { content: string }).content)).toEqual({
    output: "a drawing",
    attachments: [{ type: "file", mime: "image/png", url: "data:… (20 KB omitted)" }],
  });
});

test("long tool output keeps its start and end", () => {
  const content = `${"a".repeat(10_000)}${"z".repeat(10_000)}`;
  const event = chunk({ type: "TOOL_CALL_RESULT", toolCallId: "c", content });
  const trimmed = (chunkOf(trimEvent(event)) as { content: string }).content;
  expect(trimmed.length).toBeLessThan(TOOL_TEXT_LIMIT + 100);
  expect(trimmed.startsWith("aaa")).toBe(true);
  expect(trimmed.endsWith("zzz")).toBe(true);
  expect(trimmed).toContain(`… ${20_000 - TOOL_TEXT_LIMIT} characters cut …`);
});

test("long tool arguments are cut too", () => {
  const args = JSON.stringify({ title: "Write", text: "x".repeat(20_000) });
  const event = chunk({ type: "TOOL_CALL_ARGS", toolCallId: "c", delta: args, args });
  const trimmed = chunkOf(trimEvent(event)) as { delta: string; args: string };
  expect(trimmed.delta.length).toBeLessThan(TOOL_TEXT_LIMIT + 100);
  expect(trimmed.args).toBe(trimmed.delta);
  expect(trimmed.args.startsWith('{"title":"Write"')).toBe(true);
});

test("small events come back as they are", () => {
  const events: AgentEvent[] = [
    chunk({ type: "TOOL_CALL_RESULT", toolCallId: "c", content: "ok" }),
    chunk({ type: "TOOL_CALL_RESULT", toolCallId: "c", content: '[{"type":"image"' }),
    chunk({ type: "REASONING_MESSAGE_CONTENT", messageId: "r", delta: "hmm" }),
    { kind: "turn-end", turnId: "t" },
  ];
  for (const event of events) expect(trimEvent(event)).toBe(event);
});

test("the opencode corpus folds the same trimmed", () => {
  const corpus = readFileSync(
    new URL("../test/corpus/opencode-permissions.ndjson", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: AgentEvent })
    .flatMap((record) => (record.event ? [record.event] : []));
  expect(foldThread(corpus.map(trimEvent))).toEqual(foldThread(corpus));
});
