/**
 * Agent sessions on the host machine. Any agent that speaks ACP works — only
 * its launch command differs (finding 01).
 *
 * A session is a conversation of the board's (ADR 0012), not a frame's: it
 * begins with its first prompt (or a settings change before it), says which
 * frame it began in, and each turn which frame it was sent from — the frame
 * the agent acts as.
 *
 * Each session keeps one ACP connection to its agent process for as long as
 * it is in use (finding 04): settings (model, reasoning effort, …) are ACP
 * session config options, which only exist on a live session, and people
 * change them between prompts. The connection is opened for a prompt or a
 * settings change, closed after a while idle or once no frame shows the
 * session (`session/close` first, where the agent offers it), and on reopen
 * the agent's session is resumed (`session/resume`, else `session/load`) and
 * its last settings re-applied. ACP updates are turned into AG-UI chunks by
 * `@tanstack/ai-acp`'s translator, so the thread format is unchanged.
 *
 * Before any session of a kind ran, its settings come from `probe`: that
 * agent started once to list them, and stopped. Every new session of a kind
 * updates what is kept of it (`onKindOptions`).
 *
 * A session is an append-only event log (`AgentEvent`). The manager appends to
 * it and fans every event out through `emit`; persistence and the WebSocket
 * are the caller's concern.
 */

import {
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  AsyncQueue,
  translateAcpStream,
  type AcpSessionUpdate,
  type AcpStreamEvent,
} from "@tanstack/ai-acp";
import type { Subprocess } from "bun";
import { BOARD_SERVER_NAME, BOARD_TOOL_NAMES } from "../shared/board-tools";
import type {
  AgentConfigOption,
  AgentConfigValue,
  AgentEvent,
  AgentInfo,
  AgentKind,
  AgentSetting,
  Author,
  KindOptions,
  PermissionOption,
  SessionHead,
  SessionMeta,
  SessionSnapshot,
  SessionStart,
} from "../shared/protocol";
import { PLAN_EVENT } from "../shared/protocol";
import { todoPlan } from "./todo-plan";
import { fromAcp, pendingChanges, seededSettings, settingsOf } from "./agent-config";
import { isSessionId, lastFrame } from "../shared/sessions";
import { newMeta, sessionTitle } from "./session-meta";
import { SKILLS_DIR } from "./skills";
import { trimEvent } from "./trim-event";

export interface AgentDefinition extends AgentInfo {
  readonly command: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  /** Agent-specific `_meta` for `session/new` and `session/load`. */
  readonly sessionMeta?: Record<string, unknown>;
}

const claudeAcpBin = Bun.resolveSync(
  "@agentclientprotocol/claude-agent-acp/dist/index.js",
  import.meta.dir,
);

/** How long an agent process may sit unused before it is stopped. */
const IDLE_MS = 15 * 60_000;
/** How long `session/close` may take before the process is killed anyway. */
const CLOSE_MS = 2000;

/** The ACP agents canvas knows how to launch, filtered to what is installed. */
export function detectAgents(): ReadonlyArray<AgentDefinition> {
  const opencodeModel = process.env.CANVAS_OPENCODE_MODEL ?? "opencode-go/big-pickle";
  const candidates: Array<AgentDefinition & { needs: string }> = [
    {
      kind: "claude",
      label: "Claude Code",
      needs: "claude",
      command: ["bun", claudeAcpBin],
      // The board tools run without asking: they only change the board,
      // which the host's browser already lets the agent do (finding 06).
      sessionMeta: {
        claudeCode: {
          options: {
            allowedTools: BOARD_TOOL_NAMES.map((name) => `mcp__${BOARD_SERVER_NAME}__${name}`),
            // canvas's own skills; the host's stay available beside them.
            plugins: [{ type: "local", path: SKILLS_DIR, skipMcpDiscovery: true }],
          },
        },
      },
    },
    {
      kind: "opencode",
      label: "opencode",
      needs: "opencode",
      command: ["opencode", "acp"],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          // The starting model; people pick another in the frame.
          model: opencodeModel,
          // No permission policy: opencode's defaults (ask outside the
          // project) and the host's own opencode config decide.
          // canvas's own skills; the host's stay available beside them.
          skills: { paths: [SKILLS_DIR] },
        }),
      },
    },
  ];
  // The e2e tests' seam (`e2e/acp/cassette.ts`): a JSON array that each agent's
  // command goes behind, after the agent's kind — to record its traffic, or
  // to replay a recording in place of it. The wrapper decides what runs.
  const wrapper = process.env.CANVAS_AGENT_WRAPPER;
  if (wrapper) {
    const prefix = JSON.parse(wrapper) as string[];
    return candidates.map((agent) => ({
      ...agent,
      command: [...prefix, agent.kind, "--", ...agent.command],
    }));
  }
  return candidates.filter((agent) => Bun.which(agent.needs) !== null);
}

/** An agent process, initialized. */
interface Agent {
  readonly acp: ClientSideConnection;
  readonly process: Subprocess<"pipe", "pipe", "pipe">;
  readonly init: InitializeResponse;
  /** Rejects when the process exits. */
  readonly exited: Promise<never>;
}

/** A running agent process with the session open. */
interface Live extends Agent {
  /** The agent's session id. */
  readonly sessionId: string;
}

interface Turn {
  readonly id: string;
  readonly queue: AsyncQueue<AcpStreamEvent>;
}

interface Session {
  meta: SessionMeta;
  events: AgentEvent[];
  options?: AgentConfigOption[];
  /** The settings a session begins with, until its agent first ran. */
  wanted?: ReadonlyArray<Pick<AgentSetting, "id" | "value">>;
  /** The frame the agent acts as: its running turn's, else its last turn's, else where it began. */
  frameId: string;
  /**
   * Starting for a settings change: what the agent lists meanwhile is kept,
   * not sent, so the browser's answer to the change is the change's result.
   */
  quiet?: boolean;
  live?: Promise<Live>;
  turn?: Turn;
  idleTimer?: ReturnType<typeof setTimeout>;
  pending: Map<string, (optionId: string | null) => void>;
}

/** A prompt, from `frameId`; `agent` and `settings` begin a session that doesn't exist yet. */
export interface PromptRequest extends SessionStart {
  readonly sessionId: string;
  readonly text: string;
  readonly author: Author;
}

export interface AgentManagerOptions {
  readonly dir: string;
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly restored: ReadonlyArray<SessionSnapshot>;
  /** The settings each kind offered a new session last (`agents.json`). */
  readonly kindOptions?: KindOptions;
  /** MCP servers to give a session's agent (the board tools). */
  readonly mcpServers?: (sessionId: string) => McpServer[];
  readonly onMeta: (meta: SessionMeta) => void;
  readonly onEvent: (sessionId: string, event: AgentEvent) => void;
  readonly onOptions: (sessionId: string, options: ReadonlyArray<AgentConfigOption>) => void;
  /** A kind's settings for a new session changed: what `kindOptions` keeps. */
  readonly onKindOptions: (agent: AgentKind, options: ReadonlyArray<AgentConfigOption>) => void;
  /** Something went wrong that no request is waiting to hear about. */
  readonly onError: (message: string) => void;
}

export class AgentManager {
  private readonly sessions = new Map<string, Session>();
  private readonly kinds = new Map<AgentKind, AgentConfigOption[]>();
  private readonly probing = new Set<AgentKind>();
  /** Every agent process running, to stop them all at once. */
  private readonly processes = new Set<Subprocess>();

  constructor(private readonly options: AgentManagerOptions) {
    for (const [agent, kindOptions] of Object.entries(options.kindOptions ?? {}))
      this.kinds.set(agent, [...kindOptions]);
    for (const snapshot of options.restored) {
      // A turn that was in flight when the server stopped is over. Logs
      // written before events were trimmed are trimmed here.
      const events = snapshot.events.map(trimEvent);
      this.sessions.set(snapshot.meta.id, {
        meta: { ...snapshot.meta, status: "idle" },
        events,
        frameId: lastFrame(snapshot.meta, events),
        pending: new Map(),
      });
    }
  }

  /** Every session without its log: what a browser gets first. */
  heads(): SessionHead[] {
    return [...this.sessions.values()].map((s) => ({
      meta: s.meta,
      ...(s.options && { options: s.options }),
    }));
  }

  /** A session's log so far; undefined for one that doesn't exist. */
  history(sessionId: string): ReadonlyArray<AgentEvent> | undefined {
    return this.sessions.get(sessionId)?.events.slice();
  }

  kindOptions(): KindOptions {
    return Object.fromEntries(this.kinds);
  }

  /** The frame a session's agent acts as now (ADR 0012, decision 3). */
  frameOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.frameId;
  }

  /**
   * Make sure a kind's settings for a new session are known: if not, start
   * that agent once to list them, and stop it. Safe to repeat.
   */
  probe(agent: AgentKind): void {
    if (this.kinds.has(agent) || this.probing.has(agent)) return;
    const definition = this.options.agents.find((a) => a.kind === agent);
    if (!definition) throw new Error(`unknown agent ${agent}`);
    this.probing.add(agent);
    void (async () => {
      const started = await this.start(definition, () => ({
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => undefined,
      }));
      try {
        const created = await race(started, started.acp.newSession(this.newRequest(definition)));
        this.setKindOptions(agent, created.configOptions ?? []);
        await this.stop({ ...started, sessionId: created.sessionId });
      } finally {
        this.kill(started.process);
      }
    })()
      .catch((cause: unknown) =>
        this.options.onError(`${definition.label} did not start: ${errorMessage(cause)}`),
      )
      .finally(() => this.probing.delete(agent));
  }

  /**
   * Change one setting; the agent answers with the full, updated set. A
   * session not begun yet begins as `start` says: only its agent knows which
   * settings follow a change.
   */
  async configure(
    sessionId: string,
    configId: string,
    value: AgentConfigValue,
    start?: SessionStart,
  ): Promise<void> {
    const session = this.sessions.get(sessionId) ?? (start && this.begin(sessionId, start));
    if (!session) throw new Error(`no session ${sessionId}`);
    if (!session.live) session.quiet = true;
    try {
      const live = await this.connect(session);
      const response = await live.acp.setSessionConfigOption({
        sessionId: live.sessionId,
        configId,
        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
      });
      session.quiet = false;
      // Sent even unchanged: it is the answer the browser waits for.
      this.setOptions(session, response.configOptions, true);
    } catch (cause) {
      session.quiet = false;
      if (session.options) this.options.onOptions(session.meta.id, session.options);
      throw cause;
    }
    this.touch(session);
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.turn) return;
    void session.live?.then((live) => live.acp.cancel({ sessionId: live.sessionId }));
    for (const resolve of session.pending.values()) resolve(null);
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    optionId: string | null,
    by: string,
  ): void {
    const session = this.sessions.get(sessionId);
    const resolve = session?.pending.get(requestId);
    if (!session || !resolve) return;
    session.pending.delete(requestId);
    this.append(session, { kind: "permission-resolved", requestId, optionId, by });
    this.setStatus(session, session.pending.size > 0 ? "waiting" : "running");
    resolve(optionId);
  }

  /** A prompt into a session; the first begins it, with its agent and settings. */
  prompt(request: PromptRequest): void {
    const { sessionId, frameId, text, author } = request;
    const session = this.sessions.get(sessionId) ?? this.begin(sessionId, request);
    if (session.meta.status !== "idle")
      throw new Error("the agent is still working on the last prompt");
    void this.runTurn(session, frameId, text, author);
  }

  /** No frame shows the session any more: stop its agent now, unless it is busy. */
  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.turn) this.disconnect(session);
  }

  /** Stop every agent process (server shutdown). */
  close(): void {
    for (const child of this.processes) child.kill();
  }

  private begin(id: string, start: SessionStart): Session {
    // Its id names its log file: it comes from the board doc, which guests write.
    if (!isSessionId(id)) throw new Error(`not a session id: ${id}`);
    if (!this.options.agents.some((a) => a.kind === start.agent))
      throw new Error(`unknown agent ${start.agent}`);
    const kind = this.kinds.get(start.agent);
    const meta = newMeta(id, start, Date.now());
    const session: Session = {
      // Shown until the agent lists its own: what it will start with.
      meta: kind ? { ...meta, settings: seededSettings(kind, start.settings) } : meta,
      events: [],
      ...(start.settings?.length && { wanted: start.settings }),
      frameId: start.frameId,
      pending: new Map(),
    };
    this.sessions.set(id, session);
    this.options.onMeta(session.meta);
    return session;
  }

  private async runTurn(
    session: Session,
    frameId: string,
    text: string,
    author: Author,
  ): Promise<void> {
    const turnId = crypto.randomUUID();
    const at = Date.now();
    session.frameId = frameId;
    this.append(session, { kind: "turn", turnId, text, author, at, frameId });
    this.setMeta(session, {
      status: "running",
      lastAt: at,
      ...(session.meta.title === undefined && { title: sessionTitle(text) }),
    });
    clearTimeout(session.idleTimer);

    let error: string | undefined;
    let cancelled = false as boolean;
    try {
      const live = await this.connect(session);
      const turn: Turn = { id: turnId, queue: new AsyncQueue() };
      session.turn = turn;
      live.acp
        .prompt({ sessionId: live.sessionId, prompt: [{ type: "text", text }] })
        .then((response) => {
          cancelled = response.stopReason === "cancelled";
          turn.queue.push({
            kind: "done",
            stopReason: response.stopReason,
            ...(response.usage && { usage: response.usage }),
          });
          turn.queue.end();
        })
        .catch((cause: unknown) => turn.queue.fail(cause));

      const chunks = translateAcpStream(turn.queue, {
        model: session.meta.agent,
        runId: turnId,
        threadId: session.meta.id,
        genId: () => crypto.randomUUID(),
        labels: {
          sessionIdEvent: `${session.meta.agent}.session-id`,
          contentEvent: `${session.meta.agent}.message-content`,
          planEvent: PLAN_EVENT,
        },
      });
      for await (const chunk of chunks) {
        if (chunk.type === "RUN_ERROR") error = chunk.message ?? "agent error";
        this.append(session, { kind: "chunk", turnId, chunk });
      }
    } catch (cause) {
      error = errorMessage(cause);
    }

    for (const resolve of session.pending.values()) resolve(null);
    session.pending.clear();
    session.turn = undefined;
    const end = Date.now();
    this.append(session, {
      kind: "turn-end",
      turnId,
      at: end,
      ...(error !== undefined && !cancelled && { error }),
      ...(cancelled && { cancelled: true }),
    });
    this.setMeta(session, { status: "idle", lastAt: end });
    this.touch(session);
  }

  private connect(session: Session): Promise<Live> {
    if (!session.live) {
      const forget = () => {
        if (session.live === live) session.live = undefined;
      };
      const live = this.open(session, forget);
      session.live = live;
      live.catch(forget);
    }
    this.touch(session);
    return session.live;
  }

  /** Spawn an agent and initialize it; `client` answers what the agent asks. */
  private async start(
    definition: AgentDefinition,
    client: () => Client,
    onExit?: (cause: unknown) => void,
  ): Promise<Agent> {
    const child = Bun.spawn([...definition.command], {
      cwd: this.options.dir,
      env: { ...process.env, ...definition.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.processes.add(child);
    let stderr = "";
    void (async () => {
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
        stderr = (stderr + chunk).slice(-4096);
    })().catch(() => undefined);
    const exited = child.exited.then((code) => {
      this.processes.delete(child);
      throw new Error(
        `${definition.label} exited (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`,
      );
    });
    exited.catch((cause: unknown) => onExit?.(cause));

    const stream = ndJsonStream(
      new WritableStream<Uint8Array>({
        write: (chunk) => {
          child.stdin.write(chunk);
          void child.stdin.flush();
        },
        close: () => void child.stdin.end(),
      }),
      child.stdout,
    );
    const acp = new ClientSideConnection(client, stream);
    try {
      const init = await Promise.race([
        acp.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "canvas", version: "0.0.0" },
          // The agent works on the host directly; it never needs our fs.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
        exited,
      ]);
      return { acp, process: child, init, exited };
    } catch (cause) {
      this.kill(child);
      throw cause;
    }
  }

  private newRequest(definition: AgentDefinition, sessionId?: string) {
    return {
      cwd: this.options.dir,
      mcpServers: sessionId ? (this.options.mcpServers?.(sessionId) ?? []) : [],
      ...(definition.sessionMeta && { _meta: definition.sessionMeta }),
    };
  }

  private async open(session: Session, onExit: () => void): Promise<Live> {
    const definition = this.options.agents.find((a) => a.kind === session.meta.agent);
    if (!definition) throw new Error(`${session.meta.agent} is not installed on the host`);

    const agent = await this.start(
      definition,
      () => ({
        requestPermission: (params) => this.askPermission(session, params),
        sessionUpdate: async ({ update }) => this.onUpdate(session, update),
      }),
      (cause) => {
        onExit();
        session.turn?.queue.fail(cause);
      },
    );

    try {
      const request = this.newRequest(definition, session.meta.id);
      const capabilities = agent.init.agentCapabilities;
      let sessionId: string | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      const previous = session.meta.acpSessionId;
      // The agent's own history is what the model remembers: back to it,
      // without a replay where the agent can (a replay comes as updates while
      // no turn is open, and is dropped).
      const again = !previous
        ? null
        : capabilities?.sessionCapabilities?.resume
          ? agent.acp.resumeSession({ ...request, sessionId: previous })
          : capabilities?.loadSession
            ? agent.acp.loadSession({ ...request, sessionId: previous })
            : null;
      if (again) {
        const back = await race(agent, again).catch(() => null);
        if (back) {
          sessionId = previous;
          configOptions = back.configOptions;
        }
      }
      if (!sessionId) {
        const created = await race(agent, agent.acp.newSession(request));
        sessionId = created.sessionId;
        configOptions = created.configOptions;
        if (configOptions) this.setKindOptions(definition.kind, configOptions);
        this.setMeta(session, { acpSessionId: sessionId });
      }
      const live: Live = { ...agent, sessionId };
      if (configOptions) {
        const wanted = session.wanted ?? session.meta.settings ?? [];
        session.wanted = undefined;
        this.setOptions(session, configOptions);
        await this.restoreSettings(session, live, wanted);
      }
      return live;
    } catch (cause) {
      this.kill(agent.process);
      throw cause;
    }
  }

  /**
   * A reopened session starts from the agent's defaults: put back what the
   * session had, one change at a time, as each can change the others.
   */
  private async restoreSettings(
    session: Session,
    live: Live,
    wanted: ReadonlyArray<Pick<AgentSetting, "id" | "value">>,
  ): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const next = pendingChanges(session.options ?? [], wanted).find((c) => !tried.has(c.id));
      if (!next) return;
      tried.add(next.id);
      try {
        const response = await live.acp.setSessionConfigOption({
          sessionId: live.sessionId,
          configId: next.id,
          ...(typeof next.value === "boolean"
            ? { type: "boolean" as const, value: next.value }
            : { value: next.value }),
        });
        this.setOptions(session, response.configOptions);
      } catch {
        // The agent refused it; keep what it reports.
      }
    }
  }

  private onUpdate(session: Session, update: SessionUpdate): void {
    if (update.sessionUpdate === "config_option_update")
      return this.setOptions(session, update.configOptions);
    if (update.sessionUpdate === "usage_update") {
      const { used, size, cost } = update;
      const usage = {
        used,
        size,
        ...(cost && { cost: { amount: cost.amount, currency: cost.currency } }),
      };
      return this.setMeta(session, { usage });
    }
    session.turn?.queue.push({ kind: "update", update: update as AcpSessionUpdate });
    const plan = todoPlan(update);
    if (plan) session.turn?.queue.push({ kind: "update", update: plan as AcpSessionUpdate });
  }

  /** Park the agent's ask until the host answers it in the browser. */
  private async askPermission(
    session: Session,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const turn = session.turn;
    if (!turn) return { outcome: { outcome: "cancelled" } };
    const requestId = crypto.randomUUID();
    const options: PermissionOption[] = request.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const optionId = await new Promise<string | null>((resolve) => {
      session.pending.set(requestId, resolve);
      this.append(session, {
        kind: "permission",
        turnId: turn.id,
        requestId,
        toolCallId: request.toolCall.toolCallId,
        title: request.toolCall.title ?? "Tool call",
        options,
      });
      this.setStatus(session, "waiting");
    });
    return {
      outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
    };
  }

  private setOptions(
    session: Session,
    raw: ReadonlyArray<SessionConfigOption>,
    always = false,
  ): void {
    const options = fromAcp(raw);
    const settings = settingsOf(options);
    if (session.quiet) {
      session.options = options;
      session.meta = { ...session.meta, settings };
      return;
    }
    if (always || JSON.stringify(options) !== JSON.stringify(session.options)) {
      session.options = options;
      this.options.onOptions(session.meta.id, options);
    }
    if (JSON.stringify(settings) !== JSON.stringify(session.meta.settings))
      this.setMeta(session, { settings });
  }

  /** What a kind offers a new session, as a fresh session of it just listed. */
  private setKindOptions(agent: AgentKind, raw: ReadonlyArray<SessionConfigOption>): void {
    const options = fromAcp(raw);
    if (JSON.stringify(options) === JSON.stringify(this.kinds.get(agent))) return;
    this.kinds.set(agent, options);
    this.options.onKindOptions(agent, options);
  }

  /** (Re)start the idle clock; a running turn keeps the agent alive. */
  private touch(session: Session): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.turn) this.disconnect(session);
    }, IDLE_MS);
  }

  private disconnect(session: Session): void {
    clearTimeout(session.idleTimer);
    const live = session.live;
    session.live = undefined;
    void live?.then((l) => this.stop(l)).catch(() => undefined);
  }

  /** Close the agent's session where it offers that (it may tidy up), then end the process. */
  private async stop(live: Live): Promise<void> {
    try {
      if (live.init.agentCapabilities?.sessionCapabilities?.close)
        await Promise.race([
          live.acp.closeSession({ sessionId: live.sessionId }),
          live.exited,
          Bun.sleep(CLOSE_MS),
        ]).catch(() => undefined);
    } finally {
      this.kill(live.process);
    }
  }

  private kill(child: Subprocess): void {
    this.processes.delete(child);
    child.kill();
  }

  private append(session: Session, raw: AgentEvent): void {
    const event = trimEvent(raw);
    session.events.push(event);
    this.options.onEvent(session.meta.id, event);
  }

  private setStatus(session: Session, status: SessionMeta["status"]): void {
    if (session.meta.status !== status) this.setMeta(session, { status });
  }

  private setMeta(session: Session, change: Partial<SessionMeta>): void {
    session.meta = { ...session.meta, ...change };
    this.options.onMeta(session.meta);
  }
}

/** An agent's answer, unless its process exits first. */
const race = <T>(agent: Agent, work: Promise<T>) => Promise.race([work, agent.exited]);

const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause);
