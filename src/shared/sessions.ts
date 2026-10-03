/**
 * What both halves know about sessions apart from frames (ADR 0012): which
 * ids are sessions' at all, and which frame a session's agent acts as.
 */

import type { AgentEvent, SessionMeta } from "./protocol";

/**
 * A session id names its log (`.canvas/sessions/<id>.ndjson`) and its MCP
 * server, and comes from the board doc, which guests write: letters, digits,
 * `-` and `_` only.
 */
export const isSessionId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** The frame a session's agent acts as: its last turn's, else the one it began in. */
export function lastFrame(meta: SessionMeta, events: ReadonlyArray<AgentEvent>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "turn" && event.frameId) return event.frameId;
  }
  return meta.frameId;
}
