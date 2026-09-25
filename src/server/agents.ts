/**
 * Agent sessions on the host machine: one `chat()` call per turn through
 * `@tanstack/ai-acp`'s generic `acpCompatible` adapter, so any agent that
 * speaks ACP works — only its launch command differs (finding 01).
 *
 * A session is an append-only event log (`AgentEvent`). The manager appends to
 * it and fans every event out through `emit`; persistence and the WebSocket
 * are the caller's concern.
 */

import { chat } from "@tanstack/ai";
import { acpCompatible, type AcpCompatibleConfig } from "@tanstack/ai-acp";
import { defineSandbox, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import type {
  AgentEvent,
  AgentInfo,
  AgentKind,
  Author,
  PermissionOption,
  SessionMeta,
  SessionSnapshot,
} from "../shared/protocol";

interface AgentDefinition extends AgentInfo {
  readonly command: string;
  readonly env?: Record<string, string>;
}

const claudeAcpBin = Bun.resolveSync("@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.dir);

/** The ACP agents canvas knows how to launch, filtered to what is installed. */
export function detectAgents(): ReadonlyArray<AgentDefinition> {
  const opencodeModel = process.env.CANVAS_OPENCODE_MODEL ?? "opencode-go/big-pickle";
  const candidates: Array<AgentDefinition & { needs: string }> = [
    {
      kind: "claude",
      label: "Claude Code",
      needs: "claude",
      command: `bun ${claudeAcpBin}`,
    },
    {
      kind: "opencode",
      label: "opencode",
      needs: "opencode",
      command: "opencode acp",
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: opencodeModel,
          // Shell commands ask, so a person approves anything the agent runs.
          permission: { bash: "ask" },
        }),
      },
    },
  ];
  return candidates.filter((agent) => Bun.which(agent.needs) !== null);
}

interface Session {
  meta: SessionMeta;
  events: AgentEvent[];
  abort?: AbortController;
  pending: Map<string, (optionId: string | null) => void>;
}

export interface AgentManagerOptions {
  readonly dir: string;
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly restored: ReadonlyArray<SessionSnapshot>;
  readonly onMeta: (meta: SessionMeta) => void;
  readonly onEvent: (sessionId: string, event: AgentEvent) => void;
}

export class AgentManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: AgentManagerOptions) {
    for (const snapshot of options.restored) {
      // A turn that was in flight when the server stopped is over.
      this.sessions.set(snapshot.meta.id, {
        meta: { ...snapshot.meta, status: "idle" },
        events: [...snapshot.events],
        pending: new Map(),
      });
    }
  }

  snapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => ({ meta: s.meta, events: s.events }));
  }

  create(id: string, agent: AgentKind): void {
    if (this.sessions.has(id)) return;
    if (!this.options.agents.some((a) => a.kind === agent)) throw new Error(`unknown agent ${agent}`);
    const session: Session = { meta: { id, agent, status: "idle" }, events: [], pending: new Map() };
    this.sessions.set(id, session);
    this.options.onMeta(session.meta);
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.abort?.abort();
    for (const resolve of session?.pending.values() ?? []) resolve(null);
  }

  resolvePermission(sessionId: string, requestId: string, optionId: string | null, by: string): void {
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
    if (session.meta.status !== "idle") throw new Error("the agent is still working on the last prompt");
    void this.runTurn(session, text, author);
  }

  private async runTurn(session: Session, text: string, author: Author): Promise<void> {
    const definition = this.options.agents.find((a) => a.kind === session.meta.agent);
    if (!definition) return;
    const turnId = crypto.randomUUID();
    const abort = new AbortController();
    session.abort = abort;
    this.append(session, { kind: "turn", turnId, text, author, at: Date.now() });
    this.setStatus(session, "running");

    const config: AcpCompatibleConfig = {
      name: definition.kind,
      command: () => definition.command,
      authMode: "host",
      env: definition.env,
      // The default policy lets edits through inside the working dir and asks
      // for anything else; asks are parked here until the host answers.
      onPermissionRequest: async (request) => {
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
            turnId,
            requestId,
            title: request.toolCall.title ?? "Tool call",
            options,
          });
          this.setStatus(session, "waiting");
        });
        return optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId };
      },
    };

    const sandbox = defineSandbox({
      id: `canvas-${session.meta.id}`,
      provider: localProcessSandbox({ dir: this.options.dir }),
      lifecycle: { reuse: "thread", destroyOnComplete: false },
    });

    let error: string | undefined;
    try {
      const stream = chat({
        adapter: acpCompatible(config)("default"),
        threadId: session.meta.id,
        messages: [{ role: "user", content: text }],
        modelOptions: session.meta.acpSessionId ? { sessionId: session.meta.acpSessionId } : {},
        middleware: [withSandbox(sandbox)],
        abortController: abort,
      }) as AsyncIterable<{ type: string; name?: string; value?: unknown; message?: string }>;

      for await (const chunk of stream) {
        if (chunk.type === "CUSTOM" && chunk.name === `${definition.kind}.session-id`) {
          const acpSessionId = (chunk.value as { sessionId?: string }).sessionId;
          if (acpSessionId) session.meta = { ...session.meta, acpSessionId };
          continue;
        }
        // Sandbox bookkeeping, not part of the conversation.
        if (chunk.type === "CUSTOM" && chunk.name?.startsWith("sandbox.")) continue;
        if (chunk.type === "RUN_ERROR") error = chunk.message ?? "agent error";
        this.append(session, { kind: "chunk", turnId, chunk });
      }
    } catch (cause) {
      if (!abort.signal.aborted) error = cause instanceof Error ? cause.message : String(cause);
    }

    for (const resolve of session.pending.values()) resolve(null);
    session.pending.clear();
    session.abort = undefined;
    this.append(session, {
      kind: "turn-end",
      turnId,
      ...(error !== undefined && { error }),
      ...(abort.signal.aborted && { cancelled: true }),
    });
    this.setStatus(session, "idle");
  }

  private append(session: Session, event: AgentEvent): void {
    session.events.push(event);
    this.options.onEvent(session.meta.id, event);
  }

  private setStatus(session: Session, status: SessionMeta["status"]): void {
    if (session.meta.status === status) return;
    session.meta = { ...session.meta, status };
    this.options.onMeta(session.meta);
  }
}
