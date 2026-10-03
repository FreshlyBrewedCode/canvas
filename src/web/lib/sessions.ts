/**
 * Agent sessions as browsers see them (ADR 0012): `canvas serve` keeps them
 * for the board, frames show one each (`shownSession`, `board.ts`). What is
 * worked out here is pure — which sessions a frame lists, what a new
 * conversation starts with, which frames a waiting session points at, which
 * requests a frame lets through, when an agent process may go, and how a log
 * arriving in pieces comes together — and `room.ts` does it.
 */

import { withSettings } from "../../shared/agent-settings";
import type {
  AgentConfigOption,
  AgentEvent,
  AgentSetting,
  SessionMeta,
  SessionStart,
  SessionStatus,
} from "../../shared/protocol";
import { shownSession, type AgentFrame, type Frame } from "./board";

const newestFirst = (a: SessionMeta, b: SessionMeta) => b.lastAt - a.lastAt;

/** Every session of the board, the last active first. */
export function boardSessions(metas: Iterable<SessionMeta>): SessionMeta[] {
  return [...metas].sort(newestFirst);
}

/** The sessions that began in a frame (decision 2), the last active first. */
export function frameSessions(metas: Iterable<SessionMeta>, frameId: string): SessionMeta[] {
  return [...metas].filter((meta) => meta.frameId === frameId).sort(newestFirst);
}

/** A line of an agent frame's conversation menu. */
export interface Conversation {
  readonly id: string;
  /** Its first prompt, shortened; none before it has one. */
  readonly title?: string;
  /** When it was last active; none if it hasn't begun. */
  readonly lastAt?: number;
  readonly status: SessionStatus;
  /** The one the frame shows. */
  readonly shown: boolean;
}

/**
 * An agent frame's conversations as its menu lists them: those that began in
 * it (`frameSessions`), the last active first, and the one it shows wherever
 * that began — on top while it hasn't begun (decision 4: a fresh id, no
 * record yet). Others never prompted are left out: a settings change begins a
 * session too, and there is nothing in it to go back to.
 */
export function conversations(
  mine: ReadonlyArray<SessionMeta>,
  shown: string,
  shownMeta: SessionMeta | undefined,
): Conversation[] {
  const line = (meta: SessionMeta): Conversation => ({
    id: meta.id,
    ...(meta.title !== undefined && { title: meta.title }),
    lastAt: meta.lastAt,
    status: meta.status,
    shown: meta.id === shown,
  });
  const list = mine.filter((meta) => meta.id === shown || meta.title !== undefined).map(line);
  if (list.some((c) => c.shown)) return list;
  if (!shownMeta) return [{ id: shown, status: "idle", shown: true }, ...list];
  return [line(shownMeta), ...list].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

/** Where an empty conversation offers to go back to: the frame's last active other one. */
export function backTo(list: ReadonlyArray<Conversation>): Conversation | undefined {
  return list.find((c) => !c.shown && c.title !== undefined);
}

/** The agent frames showing a session. */
export function framesShowing(frames: ReadonlyArray<Frame>, sessionId: string): AgentFrame[] {
  return frames.filter(
    (frame): frame is AgentFrame =>
      frame.type === "agent" && !!frame.agent && shownSession(frame) === sessionId,
  );
}

/** The sessions agent frames show, begun or not. */
export function shownSessions(frames: ReadonlyArray<Frame>): Set<string> {
  return new Set(
    frames.flatMap((frame) => (frame.type === "agent" && frame.agent ? [shownSession(frame)] : [])),
  );
}

/**
 * What a new conversation in `frame` starts with (decision 4): the settings
 * of the one it shows — its own once begun (`shown`), else those it was to
 * start with.
 */
export function nextSettings(
  frame: AgentFrame,
  shown: SessionMeta | undefined,
): ReadonlyArray<AgentSetting> | undefined {
  return shown ? shown.settings : frame.settings;
}

/**
 * How the session `frame` shows begins, if `canvas serve` has no record of
 * it (`begun` false): in that frame, with its agent and starting settings.
 */
export function startIn(frame: AgentFrame, begun: boolean): SessionStart {
  const settings = begun ? undefined : frame.settings?.map(({ id, value }) => ({ id, value }));
  return { frameId: frame.id, agent: frame.agent, ...(settings?.length && { settings }) };
}

/** A session not begun shows what its kind offers, at the values its frame starts it with. */
export function unbegunOptions(
  kind: ReadonlyArray<AgentConfigOption> | undefined,
  frame: AgentFrame,
): ReadonlyArray<AgentConfigOption> | undefined {
  return kind && withSettings(kind, frame.settings);
}

/**
 * The frames a waiting session's "needs you" points at (decision 3): those
 * showing it, else the frame of its turn — if that is still on the board.
 */
export function waitingFrames(
  frames: ReadonlyArray<Frame>,
  waiting: ReadonlyArray<{ readonly id: string; readonly frameId: string }>,
): string[] {
  const out = new Set<string>();
  const ids = new Set(frames.map((frame) => frame.id));
  for (const session of waiting) {
    const showing = framesShowing(frames, session.id);
    if (showing.length) for (const frame of showing) out.add(frame.id);
    else if (ids.has(session.frameId)) out.add(session.frameId);
  }
  return [...out];
}

/**
 * The frame a prompt is sent from, if it is an agent frame showing that
 * session: a prompt goes into what the frame shows, never into any session
 * through any frame.
 */
export function promptFrame(
  frames: ReadonlyArray<Frame>,
  frameId: string,
  sessionId: string,
): AgentFrame {
  const frame = frames.find((f) => f.id === frameId);
  if (frame?.type !== "agent" || !frame.agent) throw new Error("no such agent frame");
  if (shownSession(frame) !== sessionId)
    throw new Error("the frame shows another conversation now");
  return frame;
}

/**
 * Host: when agent processes may stop (decision 5). A session no frame shows
 * any more is released at once if idle; if busy, once its turn is over —
 * unless a frame shows it again by then.
 */
export class Releases {
  private shown = new Set<string>();
  private later = new Set<string>();

  /** The sessions frames show now; those to release now. */
  show(now: ReadonlySet<string>, status: (id: string) => SessionStatus | undefined): string[] {
    const release: string[] = [];
    for (const id of this.shown) {
      if (now.has(id)) continue;
      const was = status(id);
      // Never begun: no process.
      if (was === "idle") release.push(id);
      else if (was) this.later.add(id);
    }
    for (const id of now) this.later.delete(id);
    this.shown = new Set(now);
    return release;
  }

  /** A session's status changed: whether to release it now. */
  settle(id: string, status: SessionStatus): boolean {
    return status === "idle" && this.later.delete(id);
  }
}

/** A live event with its place in its session's log (the host numbers them). */
export interface Placed {
  readonly index: number;
  readonly event: AgentEvent;
}

/**
 * Where a live event goes on a log `length` long: at its end, nowhere (the
 * log has it), or not yet — some are missing before it, a history fills them.
 */
export function place(length: number, index: number): "append" | "have" | "gap" {
  return index === length ? "append" : index < length ? "have" : "gap";
}

/**
 * A session's history with what arrived besides it, by place: the history,
 * then whatever of `live` continues it. Histories and live events come over
 * different paths and in any order; the log is the same on every peer.
 */
export function mergeLog(
  history: ReadonlyArray<AgentEvent>,
  live: ReadonlyArray<Placed>,
): AgentEvent[] {
  const log = [...history];
  for (const { index, event } of [...live].sort((a, b) => a.index - b.index))
    if (index === log.length) log.push(event);
  return log;
}
