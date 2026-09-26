/**
 * The board tools as an MCP server, one per agent session (finding 06).
 *
 * ACP lets a client hand its agent MCP servers in `session/new`; canvas hands
 * each session this one, at `/mcp/<sessionId>` with a secret of its own, so a
 * call says which agent frame it comes from. It speaks the stateless subset of
 * MCP's streamable HTTP transport: one JSON-RPC message (or batch) per POST,
 * answered with JSON; no server-sent stream.
 *
 * The board lives in the host's browser, so a tool call is relayed there
 * (`board-call`) and its answer (`board-result`) returned to the agent. File
 * paths are checked against the shared set here first (ADR 0002), so the
 * agent hears why a file can't be shown. It listens on loopback only: agents
 * run on this machine.
 */

import { randomBytes } from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import { BOARD_SERVER_NAME, BOARD_TOOLS, boardInstructions } from "../shared/board-tools";
import type { FileContent } from "../shared/protocol";

export interface BoardCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
}

export interface BoardMcpOptions {
  /** A file as the shared set lets it out. */
  readonly read: (path: string) => FileContent;
  /** Send a call to the host's browser; false if none is connected. */
  readonly relay: (call: BoardCall) => boolean;
  readonly timeoutMs?: number;
}

interface Rpc {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

const LATEST_PROTOCOL = "2025-06-18";

export class BoardMcp {
  private readonly secrets = new Map<string, string>();
  private readonly pending = new Map<
    string,
    { resolve: (result: ToolResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: BoardMcpOptions) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.fetch(req),
    });
  }

  /** The MCP server entry for a session's `session/new` / `session/load`. */
  serverFor(sessionId: string): Extract<McpServer, { type: "http" }> {
    let secret = this.secrets.get(sessionId);
    if (!secret) this.secrets.set(sessionId, (secret = randomBytes(24).toString("base64url")));
    return {
      type: "http",
      name: BOARD_SERVER_NAME,
      url: `http://127.0.0.1:${this.server.port}/mcp/${encodeURIComponent(sessionId)}`,
      headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
    };
  }

  /** The host's browser answered a call. */
  result(callId: string, ok: boolean, text: string): void {
    const waiting = this.pending.get(callId);
    if (!waiting) return;
    this.pending.delete(callId);
    clearTimeout(waiting.timer);
    waiting.resolve(ok ? done(text) : failed(text));
  }

  stop(): void {
    void this.server.stop(true);
    for (const [callId] of this.pending) this.result(callId, false, "canvas serve stopped");
  }

  private async fetch(req: Request): Promise<Response> {
    const match = /^\/mcp\/([^/]+)$/.exec(new URL(req.url).pathname);
    const sessionId = match ? decodeURIComponent(match[1]!) : null;
    const secret = sessionId ? this.secrets.get(sessionId) : undefined;
    if (!sessionId || !secret) return new Response("not found", { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${secret}`)
      return new Response("bad secret", { status: 401 });
    if (req.method !== "POST") return new Response(null, { status: 405 });

    let body: Rpc | Rpc[];
    try {
      body = (await req.json()) as Rpc | Rpc[];
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
        { status: 400 },
      );
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies = (
      await Promise.all(messages.map((message) => this.answer(sessionId, message)))
    ).filter((reply) => reply !== null);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  }

  private async answer(sessionId: string, message: Rpc): Promise<object | null> {
    // Notifications (no id) need no answer.
    if (message.id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion:
            typeof message.params?.protocolVersion === "string"
              ? message.params.protocolVersion
              : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BOARD_SERVER_NAME, version: "0.0.0" },
          instructions: boardInstructions(sessionId),
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: BOARD_TOOLS });
      case "tools/call": {
        const { name, arguments: args = {} } = (message.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        return reply(await this.call(sessionId, String(name), args));
      }
      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        };
    }
  }

  private async call(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!BOARD_TOOLS.some((t) => t.name === tool)) return failed(`no tool ${tool}`);
    let note = "";
    if (typeof args.path === "string" && args.path.trim()) {
      const path = args.path.trim().replace(/^(\.\/)+/, "");
      const file = this.options.read(path);
      if (file.kind === "denied") return failed(file.reason);
      if (file.kind === "missing")
        note = `\n(${path} doesn't exist yet; the frame shows it as soon as it is written.)`;
      if (file.kind === "text" && typeof args.start_line === "number") {
        const lines = file.text.split("\n").length - (file.text.endsWith("\n") ? 1 : 0);
        if (args.start_line > lines) return failed(`${path} has ${lines} lines`);
      }
    }

    const callId = crypto.randomUUID();
    const result = new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(
        () => this.result(callId, false, "the board did not answer in time"),
        this.options.timeoutMs ?? 15_000,
      );
      this.pending.set(callId, { resolve, timer });
    });
    if (!this.options.relay({ callId, sessionId, tool, args })) {
      this.result(
        callId,
        false,
        "the board isn't open right now: it lives in the host's browser, which is not connected",
      );
    }
    const answer = await result;
    return note && !answer.isError ? done(answer.content[0]!.text + note) : answer;
  }
}

const done = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
