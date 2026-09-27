/**
 * Agent sessions on the host machine. Any agent that speaks ACP works — only
 * its launch command differs (finding 01).
 *
 * Each session keeps one ACP connection to its agent process for as long as
 * it is in use (finding 04): settings (model, reasoning effort, …) are ACP
 * session config options, which only exist on a live session, and people
 * change them between prompts. The connection is opened on demand, closed
 * after a while idle, and on reopen the session is loaded and its last
 * settings re-applied. ACP updates are turned into AG-UI chunks by
 * `@tanstack/ai-acp`'s translator, so the thread format is unchanged.
 *
 * A session is an append-only event log (`AgentEvent`). The manager appends to
 * it and fans every event out through `emit`; persistence and the WebSocket
 * are the caller's concern.
 */

import {
  ClientSideConnection,
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
  PermissionOption,
  SessionMeta,
  SessionSnapshot,
} from "../shared/protocol";
import { fromAcp, pendingChanges, settingsOf } from "./agent-config";
import { SKILLS_DIR } from "./skills";
import { trimEvent } from "./trim-event";

interface AgentDefinition extends AgentInfo {
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

/** The ACP agents canvas knows how to launch, filtered to what is installed. */
export function detectAgents(): ReadonlyArray<AgentDefinition> {
  const opencodeModel = process.env.CANVAS_OPENCODE_MODEL ?? "opencode-go/big-pickle";
  const candidates: Array<AgentDefinition & { needs: string }> = [
    {
      kind: "claude",
      label: "Claude Code",
      needs: "claude",
      command: ["bun", claudeAcpBin],
      // Tool search defers MCP tools until the model looks them up, and smaller
      // models then call the board tools without their arguments (finding 15).
      env: { ENABLE_TOOL_SEARCH: "false" },
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
          // Shell commands ask, so a person approves anything the agent runs.
          permission: { bash: "ask" },
          // canvas's own skills; the host's stay available beside them.
          skills: { paths: [SKILLS_DIR] },
        }),
      },
    },
  ];
  return candidates.filter((agent) => Bun.which(agent.needs) !== null);
}

/** A running agent process with the session open. */
interface Live {
  readonly acp: ClientSideConnection;
  readonly sessionId: string;
  readonly process: Subprocess<"pipe", "pipe", "pipe">;
}

interface Turn {
  readonly id: string;
  readonly queue: AsyncQueue<AcpStreamEvent>;
}

interface Session {
  meta: SessionMeta;
  events: AgentEvent[];
  options?: AgentConfigOption[];
  live?: Promise<Live>;
  turn?: Turn;
  idleTimer?: ReturnType<typeof setTimeout>;
  pending: Map<string, (optionId: string | null) => void>;
}

export interface AgentManagerOptions {
  readonly dir: string;
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly restored: ReadonlyArray<SessionSnapshot>;
  /** MCP servers to give a session's agent (the board tools). */
  readonly mcpServers?: (sessionId: string) => McpServer[];
  readonly onMeta: (meta: SessionMeta) => void;
  readonly onEvent: (sessionId: string, event: AgentEvent) => void;
  readonly onOptions: (sessionId: string, options: ReadonlyArray<AgentConfigOption>) => void;
  /** Something went wrong that no request is waiting to hear about. */
  readonly onError: (message: string) => void;
}

export class AgentManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: AgentManagerOptions) {
    for (const snapshot of options.restored) {
      // A turn that was in flight when the server stopped is over. Logs
      // written before events were trimmed are trimmed here.
      this.sessions.set(snapshot.meta.id, {
        meta: { ...snapshot.meta, status: "idle" },
        events: snapshot.events.map(trimEvent),
        pending: new Map(),
      });
    }
  }

  snapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => ({
      meta: s.meta,
      events: s.events,
      ...(s.options && { options: s.options }),
    }));
  }

  /**
   * Make sure a session exists and its agent has listed its settings. Safe to
   * repeat: the host's browser sends this for every agent frame it sees.
   */
  create(id: string, agent: AgentKind): void {
    let session = this.sessions.get(id);
    if (!session) {
      if (!this.options.agents.some((a) => a.kind === agent))
        throw new Error(`unknown agent ${agent}`);
      session = { meta: { id, agent, status: "idle" }, events: [], pending: new Map() };
      this.sessions.set(id, session);
      this.options.onMeta(session.meta);
    }
    if (!session.options)
      this.connect(session).catch((cause: unknown) =>
        this.options.onError(`${agent} did not start: ${errorMessage(cause)}`),
      );
  }

  /** Change one setting; the agent answers with the full, updated set. */
  async configure(sessionId: string, configId: string, value: AgentConfigValue): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const live = await this.connect(session);
    const response = await live.acp.setSessionConfigOption({
      sessionId: live.sessionId,
      configId,
      ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
    });
    this.setOptions(session, response.configOptions);
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

  prompt(sessionId: string, text: string, author: Author): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    if (session.meta.status !== "idle")
      throw new Error("the agent is still working on the last prompt");
    void this.runTurn(session, text, author);
  }

  /** Stop every agent process (server shutdown). */
  close(): void {
    for (const session of this.sessions.values()) this.disconnect(session);
  }

  private async runTurn(session: Session, text: string, author: Author): Promise<void> {
    const turnId = crypto.randomUUID();
    this.append(session, { kind: "turn", turnId, text, author, at: Date.now() });
    this.setStatus(session, "running");
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
    this.append(session, {
      kind: "turn-end",
      turnId,
      ...(error !== undefined && !cancelled && { error }),
      ...(cancelled && { cancelled: true }),
    });
    this.setStatus(session, "idle");
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

  private async open(session: Session, onExit: () => void): Promise<Live> {
    const definition = this.options.agents.find((a) => a.kind === session.meta.agent);
    if (!definition) throw new Error(`${session.meta.agent} is not installed on the host`);

    const child = Bun.spawn([...definition.command], {
      cwd: this.options.dir,
      env: { ...process.env, ...definition.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let stderr = "";
    void (async () => {
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
        stderr = (stderr + chunk).slice(-4096);
    })().catch(() => undefined);
    const exited = child.exited.then((code) => {
      throw new Error(
        `${definition.label} exited (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`,
      );
    });
    exited.catch((cause: unknown) => {
      onExit();
      session.turn?.queue.fail(cause);
    });

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
    const acp = new ClientSideConnection(
      () => ({
        requestPermission: (params) => this.askPermission(session, params),
        sessionUpdate: async ({ update }) => this.onUpdate(session, update),
      }),
      stream,
    );
    const race = <T>(work: Promise<T>) => Promise.race([work, exited]);

    try {
      const init = await race(
        acp.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "canvas", version: "0.0.0" },
          // The agent works on the host directly; it never needs our fs.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
      );
      const request = {
        cwd: this.options.dir,
        mcpServers: this.options.mcpServers?.(session.meta.id) ?? [],
        ...(definition.sessionMeta && { _meta: definition.sessionMeta }),
      };
      let sessionId: string | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      const resume = session.meta.acpSessionId;
      if (resume && init.agentCapabilities?.loadSession) {
        // History replays as updates while no turn is open; they are dropped.
        const loaded = await race(acp.loadSession({ ...request, sessionId: resume })).catch(
          () => null,
        );
        if (loaded) {
          sessionId = resume;
          configOptions = loaded.configOptions;
        }
      }
      if (!sessionId) {
        const created = await race(acp.newSession(request));
        sessionId = created.sessionId;
        configOptions = created.configOptions;
        session.meta = { ...session.meta, acpSessionId: sessionId };
        this.options.onMeta(session.meta);
      }
      const live: Live = { acp, sessionId, process: child };
      if (configOptions) {
        const wanted = session.meta.settings ?? [];
        this.setOptions(session, configOptions);
        await this.restoreSettings(session, live, wanted);
      }
      return live;
    } catch (cause) {
      child.kill();
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
    wanted: ReadonlyArray<AgentSetting>,
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
    session.turn?.queue.push({ kind: "update", update: update as AcpSessionUpdate });
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

  private setOptions(session: Session, raw: ReadonlyArray<SessionConfigOption>): void {
    const options = fromAcp(raw);
    if (JSON.stringify(options) !== JSON.stringify(session.options)) {
      session.options = options;
      this.options.onOptions(session.meta.id, options);
    }
    const settings = settingsOf(options);
    if (JSON.stringify(settings) !== JSON.stringify(session.meta.settings)) {
      session.meta = { ...session.meta, settings };
      this.options.onMeta(session.meta);
    }
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
    void live?.then((l) => l.process.kill()).catch(() => undefined);
  }

  private append(session: Session, raw: AgentEvent): void {
    const event = trimEvent(raw);
    session.events.push(event);
    this.options.onEvent(session.meta.id, event);
  }

  private setStatus(session: Session, status: SessionMeta["status"]): void {
    if (session.meta.status === status) return;
    session.meta = { ...session.meta, status };
    this.options.onMeta(session.meta);
  }
}

const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause);
