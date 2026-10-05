/**
 * What this browser knows of the things only a runtime has: agent sessions
 * with their logs (ADR 0012), what each kind of agent offers, terminal output,
 * files and each root's file list. The host fills it from `canvas serve`
 * (`gateway.ts`), guests from the host (`participant.ts`); the host brings
 * guests up to date from it (`authority.ts`).
 *
 * Everything is keyed by address (ADR 0013, decision 7; `addressKey`): the
 * bare id for the board's own runtime's, the address with it otherwise — two
 * runtimes may have the same session or PTY id.
 */

import {
  addressKey,
  canonical,
  reach,
  type Address,
  type UncheckedAddress,
} from "../../../shared/address";
import type {
  AgentConfigOption,
  AgentEvent,
  AgentKind,
  FileContent,
  HostBroadcast,
  SessionHead,
  SessionMeta,
} from "../../../shared/protocol";
import { lastFrame } from "../../../shared/sessions";
import { boardSessions, mergeLog, place, type Placed } from "../sessions";
import { runtimeOf } from "./reach";
import type { Emitter } from "./topics";

const TERM_SCROLLBACK = 200_000;

export type AgentOptions = ReadonlyArray<AgentConfigOption>;

/** Something mirrored, with its address as writers write it and its id there. */
type Mirrored<T> = T & { readonly at: Address; readonly id: string };

export interface MirroredSession {
  /** Its runtime, as writers write it: none for the board's own. */
  readonly at: Address;
  meta: SessionMeta;
  events: AgentEvent[];
  /**
   * Its log is on its way (null once here). Guests: the live events that
   * came meanwhile, by place, to follow the history.
   */
  pending: Placed[] | null;
  options: ReadonlyArray<AgentConfigOption> | undefined;
  version: number;
}

export interface MirrorOptions {
  /** The host's events come from `canvas serve` in order, its histories are whole. */
  readonly host: boolean;
  /** The board's own runtime's id, what an absent `runtime` means; null until known. */
  readonly runtime: () => string | null;
  /** Guests: an event of the own runtime came after a gap: its log is wanted again. */
  readonly onGap: (sessionId: string) => void;
}

export class Mirror {
  /** Whether every session's head is here (the welcome's, or the host's `sessions`). */
  known = false;

  private readonly sessions = new Map<string, MirroredSession>();
  /** The settings each kind of agent offers a new session (ADR 0012), by runtime and kind. */
  private readonly kinds = new Map<string, Mirrored<{ readonly options: AgentOptions }>>();
  /** Each runtime's sessions' metas, the last active first; rebuilt after a change. */
  private readonly metaLists = new Map<string, SessionMeta[]>();
  private readonly terminals = new Map<string, Mirrored<{ readonly data: string }>>();
  private readonly files = new Map<string, Mirrored<{ readonly file: FileContent }>>();
  /** Each root's shared set's file list, once the host sends it (never to `view` guests). */
  private readonly trees = new Map<string, Mirrored<{ readonly paths: ReadonlyArray<string> }>>();

  constructor(
    private readonly emitter: Emitter,
    private readonly options: MirrorOptions,
  ) {
    // Any session's meta may have changed. First of its listeners: before any reads.
    emitter.subscribe("sessions", () => this.metaLists.clear());
  }

  private get runtime() {
    return this.options.runtime();
  }

  private emit(topic: Parameters<Emitter["emit"]>[0]) {
    this.emitter.emit(topic);
  }

  /** The key what is at `at` named `id` is mirrored under (`addressKey`). */
  keyOf(at: UncheckedAddress, id: string): string {
    return addressKey(at, this.runtime, id);
  }

  // -------------------------------------------------------------------------
  // reading

  /** A session of the runtime `at` names (absent: the board's own). */
  session(id: string, at: UncheckedAddress = {}): MirroredSession | undefined {
    return this.sessions.get(this.keyOf(at, id));
  }

  /** The settings a kind of agent offers a new session; undefined until known. */
  kindOptions(agent: AgentKind, at: UncheckedAddress = {}): AgentOptions | undefined {
    return this.kinds.get(this.keyOf(at, agent))?.options;
  }

  /** Every session on the runtime `at` names, the last active first; the same array until one changes. */
  sessionMetas(at: UncheckedAddress = {}): ReadonlyArray<SessionMeta> {
    const runtime = this.keyOf({ runtime: at.runtime }, "");
    let list = this.metaLists.get(runtime);
    if (!list) {
      const metas = [...this.sessions.values()].flatMap((s) =>
        this.keyOf(s.at, "") === runtime ? [s.meta] : [],
      );
      this.metaLists.set(runtime, (list = boardSessions(metas)));
    }
    return list;
  }

  /** The board's own runtime's sessions blocked on a permission (the host answers those). */
  waitingSessions(): Array<{ readonly id: string; readonly frameId: string }> {
    return [...this.sessions.values()]
      .filter((s) => s.meta.status === "waiting" && reach(s.at, this.runtime) === "own")
      .map((s) => ({ id: s.meta.id, frameId: lastFrame(s.meta, s.events) }));
  }

  /** A PTY's output so far, of the runtime `at` names. */
  terminal(pty: string, at: UncheckedAddress = {}): string {
    return this.terminals.get(this.keyOf(at, pty))?.data ?? "";
  }

  /** A file of the runtime and root `at` names; undefined until it arrives. */
  file(path: string, at: UncheckedAddress = {}): FileContent | undefined {
    return this.files.get(this.keyOf(at, path))?.file;
  }

  /** A root's file list; null until it arrives (never to `view` guests). */
  tree(at: UncheckedAddress = {}): ReadonlyArray<string> | null {
    return this.trees.get(this.keyOf(at, ""))?.paths ?? null;
  }

  // -------------------------------------------------------------------------
  // what a guest gets

  /**
   * Bringing a guest up to date (ADR 0012): every session's head first, a
   * message per runtime and the own one's always; then the history of each
   * own-runtime session in `shown` whose log we have, shortest first; then
   * what each kind of agent offers, terminals, files and, `withTrees`, the
   * trees.
   */
  snapshot(shown: ReadonlySet<string>, withTrees: boolean): HostBroadcast[] {
    const sessions = [...this.sessions.values()];
    const heads = new Map<string | undefined, SessionHead[]>([[undefined, []]]);
    for (const { at, meta, options } of sessions) {
      let list = heads.get(at.runtime);
      if (!list) heads.set(at.runtime, (list = []));
      list.push({ meta, ...(options && { options }) });
    }
    return [
      ...[...heads].map(([runtime, list]) => ({
        t: "sessions" as const,
        ...(runtime !== undefined && { runtime }),
        sessions: list,
      })),
      ...sessions
        .filter((s) => !s.at.runtime && shown.has(s.meta.id) && s.pending === null)
        .map((s) => ({ sessionId: s.meta.id, events: s.events.slice() }))
        .sort((a, b) => a.events.length - b.events.length)
        .map(({ sessionId, events }) => ({ t: "session-history" as const, sessionId, events })),
      ...[...this.kinds.values()].map(({ at, id: agent, options }) => ({
        t: "kind-options" as const,
        ...at,
        agent,
        options,
      })),
      ...[...this.terminals.values()].map(({ at, id: pty, data }) => ({
        t: "term-data" as const,
        ...at,
        pty,
        data,
      })),
      ...[...this.files.values()].map(({ at, id: path, file }) => ({
        t: "file" as const,
        ...at,
        path,
        file,
      })),
      ...(withTrees ? this.treeMessages() : []),
    ];
  }

  /** Every root's file list, as messages. */
  treeMessages(): HostBroadcast[] {
    return [...this.trees.values()].map(({ at, paths }) => ({ t: "tree" as const, ...at, paths }));
  }

  // -------------------------------------------------------------------------
  // filling

  /** Host: the welcome's heads and kinds, all of `canvas serve`'s runtime, the board's own. */
  welcome(heads: ReadonlyArray<SessionHead>, kindOptions: Readonly<Record<string, AgentOptions>>) {
    this.sessions.clear();
    this.known = true;
    for (const head of heads) this.putSession({}, head, null);
    this.kinds.clear();
    for (const [agent, options] of Object.entries(kindOptions)) this.putKind({}, agent, options);
    this.emit("sessions");
  }

  /** Guests: every head of one runtime; those we had of it go. Logs come later. */
  heads(at: UncheckedAddress, heads: ReadonlyArray<SessionHead>) {
    const runtime = this.keyOf({ runtime: at.runtime }, "");
    for (const [key, session] of this.sessions)
      if (this.keyOf(session.at, "") === runtime) this.sessions.delete(key);
    for (const head of heads) this.putSession(at, head, null);
    if (reach(at, this.runtime) === "own") this.known = true;
  }

  /** A session with its log, or (null) one whose history is still on its way. */
  private putSession(
    at: UncheckedAddress,
    head: SessionHead,
    events: ReadonlyArray<AgentEvent> | null,
  ) {
    const key = this.keyOf(at, head.meta.id);
    this.sessions.set(key, {
      at: runtimeOf(at, this.runtime),
      meta: head.meta,
      events: events ? [...events] : [],
      pending: events ? null : [],
      options: head.options,
      version: Date.now(),
    });
    this.emit(`session:${key}`);
    this.emit("sessions");
  }

  /**
   * A session's history arrived. Host: `canvas serve` sent it after
   * everything before, so it is all. Guests: it replaces the log we have, up
   * to its length, and what came live continues it by place (`mergeLog`) —
   * whatever came first, also a history sent again after the host's link to
   * `canvas serve` came back.
   */
  putHistory(at: UncheckedAddress, sessionId: string, events: ReadonlyArray<AgentEvent>) {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return;
    if (this.options.host) {
      if (!session.pending) return;
      session.events = [...events];
    } else {
      const live = session.pending ?? session.events.map((event, index) => ({ index, event }));
      session.events = mergeLog(events, live);
    }
    session.pending = null;
    session.version++;
    this.emit(`session:${key}`);
  }

  putKind(at: UncheckedAddress, agent: AgentKind, options: AgentOptions) {
    this.kinds.set(this.keyOf(at, agent), { at: runtimeOf(at, this.runtime), id: agent, options });
    this.emit("sessions");
  }

  putMeta(at: UncheckedAddress, meta: SessionMeta) {
    const key = this.keyOf(at, meta.id);
    const session = this.sessions.get(key);
    if (session) {
      session.meta = meta;
      session.version++;
    } else
      this.sessions.set(key, {
        at: runtimeOf(at, this.runtime),
        meta,
        events: [],
        pending: null,
        options: undefined,
        version: 0,
      });
    this.emit(`session:${key}`);
    this.emit("sessions");
  }

  putOptions(at: UncheckedAddress, sessionId: string, options: AgentOptions) {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return;
    session.options = options;
    session.version++;
    this.emit(`session:${key}`);
  }

  /**
   * An event, live; false if it was held or dropped instead. The host's come
   * from `canvas serve` in order; a guest's carry their place in the log
   * (`index`), and one after a gap asks for the log again (`onGap`).
   */
  pushEvent(at: UncheckedAddress, sessionId: string, event: AgentEvent, index?: number): boolean {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.pending) {
      // Host: its log, when it comes, has this already.
      if (!this.options.host) session.pending.push({ index: index ?? Infinity, event });
      return false;
    }
    switch (index === undefined ? "append" : place(session.events.length, index)) {
      case "have":
        return false;
      case "gap":
        session.pending = [{ index: index!, event }];
        if (reach(at, this.runtime) === "own") this.options.onGap(sessionId);
        return false;
    }
    session.events.push(event);
    session.version++;
    this.emit(`session:${key}`);
    return true;
  }

  pushTerm(at: UncheckedAddress, pty: string, data: string) {
    const key = this.keyOf(at, pty);
    const all = (this.terminal(pty, at) + data).slice(-TERM_SCROLLBACK);
    this.terminals.set(key, { at: runtimeOf(at, this.runtime), id: pty, data: all });
    this.emit(`term:${key}`);
  }

  /** Host: a terminal of the own runtime opens anew; its output starts over, unannounced. */
  restartTerminal(pty: string) {
    this.terminals.delete(pty);
  }

  putFile(at: UncheckedAddress, path: string, file: FileContent) {
    const key = this.keyOf(at, path);
    this.files.set(key, { at: canonical(at, this.runtime), id: path, file });
    this.emit(`file:${key}`);
  }

  putTree(at: UncheckedAddress, paths: ReadonlyArray<string>) {
    this.trees.set(this.keyOf(at, ""), { at: canonical(at, this.runtime), id: "", paths });
    this.emit("tree");
  }

  /** Guests, shut out: nothing of the board's runtimes stays. Unannounced. */
  clear() {
    this.sessions.clear();
    this.known = false;
    this.kinds.clear();
    this.terminals.clear();
    this.files.clear();
    this.trees.clear();
  }
}
