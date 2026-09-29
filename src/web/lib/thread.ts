/**
 * Fold a session's event log into render-ready turns. AG-UI chunk folding is
 * `StreamProcessor`'s job (the same choice factory made); this file only
 * groups by turn and joins tool calls to their results and permission asks.
 */

import {
  StreamProcessor,
  type ContentPart,
  type StreamChunk,
  type ToolResultPart,
  type UIMessage,
} from "@tanstack/ai/client";
import {
  PLAN_EVENT,
  type AgentEvent,
  type Author,
  type PermissionOption,
  type PlanEntry,
} from "../../shared/protocol";

export type Row =
  | { readonly kind: "text"; readonly key: string; readonly content: string }
  | { readonly kind: "thinking"; readonly key: string; readonly content: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly args: string;
      readonly state: string;
      readonly result: string | undefined;
      readonly isError: boolean;
      /** Permissions the agent asked for before running this call. */
      readonly permissions: ReadonlyArray<Permission>;
    };

export interface Permission {
  readonly requestId: string;
  readonly toolCallId?: string;
  readonly title: string;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly resolved: { readonly optionId: string | null; readonly by: string } | null;
}

export interface Turn {
  readonly id: string;
  readonly text: string;
  readonly author: Author;
  readonly at: number;
  readonly rows: ReadonlyArray<Row>;
  /** Permissions not tied to a tool call shown in the thread. */
  readonly permissions: ReadonlyArray<Permission>;
  readonly end: { readonly error?: string; readonly cancelled?: boolean } | null;
}

interface Accumulator {
  turn: Omit<Turn, "rows" | "permissions">;
  chunks: StreamChunk[];
  permissions: Map<string, Permission>;
}

export function foldThread(events: ReadonlyArray<AgentEvent>): Turn[] {
  const turns: Accumulator[] = [];
  const byId = new Map<string, Accumulator>();
  const permissionTurn = new Map<string, Accumulator>();

  for (const event of events) {
    switch (event.kind) {
      case "turn": {
        const acc: Accumulator = {
          turn: {
            id: event.turnId,
            text: event.text,
            author: event.author,
            at: event.at,
            end: null,
          },
          chunks: [],
          permissions: new Map(),
        };
        turns.push(acc);
        byId.set(event.turnId, acc);
        break;
      }
      case "chunk":
        byId.get(event.turnId)?.chunks.push(event.chunk as StreamChunk);
        break;
      case "permission": {
        const acc = byId.get(event.turnId);
        if (!acc) break;
        acc.permissions.set(event.requestId, { ...event, resolved: null });
        permissionTurn.set(event.requestId, acc);
        break;
      }
      case "permission-resolved": {
        const acc = permissionTurn.get(event.requestId);
        const permission = acc?.permissions.get(event.requestId);
        if (acc && permission)
          acc.permissions.set(event.requestId, {
            ...permission,
            resolved: { optionId: event.optionId, by: event.by },
          });
        break;
      }
      case "turn-end": {
        const acc = byId.get(event.turnId);
        if (acc)
          acc.turn = { ...acc.turn, end: { error: event.error, cancelled: event.cancelled } };
        break;
      }
    }
  }

  return turns.map(({ turn, chunks, permissions }) => {
    const processor = new StreamProcessor({});
    for (const chunk of chunks) processor.processChunk(chunk);
    const rows = toRows(turn.id, processor.getMessages(), [...permissions.values()]);
    const placed = new Set(rows.flatMap((row) => (row.kind === "tool" ? row.permissions : [])));
    return { ...turn, rows, permissions: [...permissions.values()].filter((p) => !placed.has(p)) };
  });
}

function toRows(
  turnId: string,
  messages: ReadonlyArray<UIMessage>,
  permissions: ReadonlyArray<Permission>,
): Row[] {
  const results = new Map<string, ToolResultPart>();
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === "tool-result") results.set(part.toolCallId, part);

  const rows: Row[] = [];
  messages.forEach((message, m) => {
    message.parts.forEach((part, p) => {
      // Stable across re-renders and identical on every peer (message ids
      // may be minted locally): remote selections anchor to it.
      const key = `${turnId}:${m}:${p}`;
      if (part.type === "text" && part.content.trim())
        rows.push({ kind: "text", key, content: part.content });
      else if (part.type === "thinking" && part.content.trim())
        rows.push({ kind: "thinking", key, content: part.content });
      else if (part.type === "tool-call") {
        const result = results.get(part.id);
        rows.push({
          kind: "tool",
          key,
          name: part.name,
          args: part.arguments,
          state: part.state,
          result: result === undefined ? undefined : contentToText(result.content),
          isError: part.state === "error" || result?.state === "error",
          permissions: permissions.filter((permission) => permission.toolCallId === part.id),
        });
      }
    });
  });
  return rows;
}

function contentToText(content: string | ReadonlyArray<ContentPart>): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.content : JSON.stringify(part)))
    .join("\n");
}

/** The agent's latest plan, whole: each plan update replaces the one before. */
export function latestPlan(events: ReadonlyArray<AgentEvent>): ReadonlyArray<PlanEntry> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "chunk") continue;
    const chunk = event.chunk as { type?: string; name?: string; value?: { entries?: unknown } };
    if (chunk.type === "CUSTOM" && chunk.name === PLAN_EVENT && Array.isArray(chunk.value?.entries))
      return chunk.value.entries as PlanEntry[];
  }
  return null;
}

/** A run of the agent's steps between two things it says, shown folded as one. */
export interface Steps {
  readonly kind: "steps";
  readonly key: string;
  readonly rows: ReadonlyArray<Row>;
  readonly tools: number;
}

/**
 * A turn's rows, with each run of steps (tool calls and reasoning, between
 * texts) that holds two tool calls or more folded into one. A call waiting on
 * a permission is never folded away: it breaks the run.
 */
export function groupSteps(rows: ReadonlyArray<Row>): Array<Row | Steps> {
  const out: Array<Row | Steps> = [];
  let run: Row[] = [];
  const flush = () => {
    const tools = run.filter((row) => row.kind === "tool").length;
    if (tools >= 2) out.push({ kind: "steps", key: `${run[0]!.key}:steps`, rows: run, tools });
    else out.push(...run);
    run = [];
  };
  for (const row of rows) {
    const waiting = row.kind === "tool" && row.permissions.some((p) => !p.resolved);
    if (row.kind === "text" || waiting) {
      flush();
      out.push(row);
    } else run.push(row);
  }
  flush();
  return out;
}
