/**
 * A session's meta (ADR 0012): where it began, when, when it was last active,
 * and its title — enough to list sessions without their logs. Logs from
 * before it was kept get it from their events.
 */

import type { AgentEvent, SessionMeta, SessionStart } from "../shared/protocol";

/** Longest title kept, in characters. */
export const TITLE_MAX = 60;

/**
 * A session's title from its first prompt: the first line with text, its
 * whitespace collapsed, cut at a word before `max` (with an ellipsis).
 */
export function sessionTitle(prompt: string, max = TITLE_MAX): string | undefined {
  const line = prompt
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return undefined;
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A session `start` begins now. */
export function newMeta(id: string, start: SessionStart, now: number): SessionMeta {
  return {
    id,
    agent: start.agent,
    status: "idle",
    frameId: start.frameId,
    createdAt: now,
    lastAt: now,
  };
}

/** What a log written before ADR 0012 lacks, from its events; `fallback` is when nothing says. */
export function withDefaults(
  meta: Omit<SessionMeta, "frameId" | "createdAt" | "lastAt"> & Partial<SessionMeta>,
  events: ReadonlyArray<AgentEvent>,
  fallback: number,
): SessionMeta {
  const times = events.flatMap((e) =>
    (e.kind === "turn" || e.kind === "turn-end") && e.at !== undefined ? [e.at] : [],
  );
  const first = events.find((e) => e.kind === "turn");
  return {
    ...meta,
    frameId: meta.frameId ?? meta.id,
    createdAt: meta.createdAt ?? times[0] ?? fallback,
    lastAt: meta.lastAt ?? times.at(-1) ?? fallback,
    ...(meta.title === undefined && first?.kind === "turn" && { title: sessionTitle(first.text) }),
  };
}

/** The frame a session's agent acts as: its last turn's, else the one it began in. */
export function lastFrame(meta: SessionMeta, events: ReadonlyArray<AgentEvent>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "turn" && event.frameId) return event.frameId;
  }
  return meta.frameId;
}
