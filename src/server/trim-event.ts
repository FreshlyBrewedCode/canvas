/**
 * What of an agent event is worth keeping. Every event is stored, and sent
 * to the host's browser and on to every guest that joins, so bulk nobody
 * reads costs on every load:
 *
 *  - a text chunk repeats the whole message so far in `content`; the thread
 *    is folded from `delta` alone, so the repeat goes;
 *  - images a tool returns (a screenshot the agent read, a drawing) stay as
 *    a placeholder with their size, as image content or as a data URL
 *    (opencode's attachments);
 *  - tool output and arguments are cut to their start and end.
 */

import type { AgentEvent } from "../shared/protocol";

/** Longest tool output or argument string kept, in characters. */
export const TOOL_TEXT_LIMIT = 4000;
/** Of a cut string, how much of the end is kept (a command's errors are there). */
const TAIL = 1000;

/** The tool chunk fields that carry the tool's input or output. */
const TOOL_FIELDS = ["content", "delta", "args", "input"] as const;

export function trimEvent(event: AgentEvent): AgentEvent {
  if (event.kind !== "chunk" || !isRecord(event.chunk)) return event;
  const chunk = event.chunk;
  if (chunk.type === "TEXT_MESSAGE_CONTENT" && "content" in chunk) {
    const { content: _, ...rest } = chunk;
    return { ...event, chunk: rest };
  }
  if (typeof chunk.type !== "string" || !chunk.type.startsWith("TOOL_CALL_")) return event;
  let trimmed: Record<string, unknown> | null = null;
  for (const field of TOOL_FIELDS) {
    const value = chunk[field];
    if (typeof value !== "string") continue;
    const next = cut(field === "content" ? withoutImages(value) : value);
    if (next !== value) (trimmed ??= { ...chunk })[field] = next;
  }
  return trimmed ? { ...event, chunk: trimmed } : event;
}

/** The start and end of a long string, and how much is missing between them. */
function cut(text: string): string {
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  const head = TOOL_TEXT_LIMIT - TAIL;
  const missing = text.length - head - TAIL;
  return `${text.slice(0, head)}\n… ${missing} characters cut …\n${text.slice(-TAIL)}`;
}

/** Tool output is a string, JSON when it has more than text: drop image data from it. */
function withoutImages(content: string): string {
  if (!content.includes('"image"') && !content.includes("data:image/")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  let found = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    if (value.type === "image") {
      found = true;
      const size = JSON.stringify(value).length;
      return { type: "image", omitted: `${Math.round(size / 1024)} KB` };
    }
    if (typeof value.url === "string" && value.url.startsWith("data:image/")) {
      found = true;
      return { ...value, url: `data:… (${Math.round(value.url.length / 1024)} KB omitted)` };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  };
  const next = walk(parsed);
  return found ? JSON.stringify(next) : content;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
