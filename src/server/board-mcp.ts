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
 *
 * Scratch files (ADR 0005) never reach the browser as content: a call's
 * `content` becomes a file in `.canvas/scratch/` here, and the call goes on
 * with its path. Reading and writing them needs no board, so those tools are
 * answered here.
 */

import { randomBytes } from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import { BOARD_SERVER_NAME, BOARD_TOOLS, boardInstructions } from "../shared/board-tools";
import type { FileContent } from "../shared/protocol";
import type { Scratch } from "./scratch";
import type { Skill } from "./skills";

export interface BoardCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
}

export interface BoardMcpOptions {
  /** A file as the shared set lets it out. */
  readonly read: (path: string) => FileContent;
  readonly scratch: Pick<Scratch, "create" | "write" | "read" | "list" | "remove">;
  /** Send a call to the host's browser; false if none is connected. */
  readonly relay: (call: BoardCall) => boolean;
  /** canvas's skills, named in the priming. */
  readonly skills?: ReadonlyArray<Skill>;
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
          instructions: boardInstructions(sessionId, this.options.skills),
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
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!BOARD_TOOLS.some((t) => t.name === tool)) return failed(`no tool ${tool}`);
    const args = { ...input };
    const notes: string[] = [];
    // Content becomes a scratch file; the board only ever sees its path.
    const created: string[] = [];
    const undo = () => created.forEach((path) => this.options.scratch.remove(path));
    try {
      switch (tool) {
        case "read_board_file":
          return done(this.readScratch(args.path));
        case "write_board_file":
          return done(this.writeScratch(args));
      }
      if (args.content !== undefined) {
        if (args.path !== undefined) throw new Error("give either path or content, not both");
        args.path = this.createScratch(args.name, args.content, created, notes);
        delete args.content;
        delete args.name;
      } else this.checkPath(args, notes);
      if (Array.isArray(args.files))
        args.files = args.files.map((value: unknown) => {
          if (typeof value !== "object" || value === null)
            throw new Error("each entry of files is an object with a display path");
          const entry = { ...(value as Record<string, unknown>) };
          if (entry.content !== undefined) {
            if (entry.path !== undefined)
              throw new Error("give a list entry either path or content, not both");
            // No name: one from the display path's last segment, e.g. "1 Overview.md" → 1-Overview.md.
            const name =
              entry.name ??
              (String(entry.display ?? "")
                .split("/")
                .at(-1)!
                .replace(/[^\w.-]+/g, "-")
                .replace(/^[^\w]+/, "") ||
                "file");
            entry.path = this.createScratch(name, entry.content, created, notes);
            delete entry.content;
            delete entry.name;
          } else this.checkPath(entry, notes);
          return entry;
        });
    } catch (error) {
      undo();
      return failed((error as Error).message);
    }
    if (tool === "view_board") {
      const scratch = this.options.scratch.list();
      notes.push(
        scratch.length ? `Scratch files: ${scratch.join(", ")}.` : "No scratch files yet.",
      );
    }

    const answer = await this.relay(sessionId, tool, args);
    if (answer.isError) {
      undo();
      return answer;
    }
    return notes.length ? done([answer.content[0]!.text, ...notes].join("\n")) : answer;
  }

  /** A named file must be in the shared set (or a scratch file), and have the lines asked for. */
  private checkPath(args: Record<string, unknown>, notes: string[]) {
    if (typeof args.path !== "string" || !args.path.trim()) return;
    const path = args.path.trim().replace(/^(\.\/)+/, "");
    const file = this.options.read(path);
    if (file.kind === "denied") throw new Error(file.reason);
    if (file.kind === "missing")
      notes.push(`(${path} doesn't exist yet; the frame shows it as soon as it is written.)`);
    if (file.kind === "text" && typeof args.start_line === "number") {
      const lines = file.text.split("\n").length - (file.text.endsWith("\n") ? 1 : 0);
      if (args.start_line > lines) throw new Error(`${path} has ${lines} lines`);
    }
  }

  private relay(sessionId: string, tool: string, args: Record<string, unknown>) {
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
    return result;
  }

  /** A new scratch file for `content`; its path. Says so in `notes`. */
  private createScratch(name: unknown, content: unknown, created: string[], notes: string[]) {
    if (typeof content !== "string") throw new Error("content must be text");
    if (typeof name !== "string" || !name.trim())
      throw new Error("content needs a name for its scratch file, e.g. overview.md");
    const path = this.options.scratch.create(name.trim(), content);
    created.push(path);
    const taken = !path.endsWith(`/${name.trim()}`);
    notes.push(`Wrote scratch file ${path}${taken ? ` (${name.trim()} was taken)` : ""}.`);
    return path;
  }

  private readScratch(path: unknown): string {
    if (typeof path !== "string") throw new Error("path must be a canvas:scratch/… path");
    const file = this.options.scratch.read(path.trim());
    if (file.kind === "text") return file.text;
    if (file.kind === "denied") throw new Error(file.reason);
    if (file.kind === "missing")
      throw new Error(`${path} doesn't exist; view_board lists the scratch files`);
    throw new Error(`${path} can't be read`);
  }

  private writeScratch(args: Record<string, unknown>): string {
    if (typeof args.path === "string" && args.path.trim()) {
      if (args.name !== undefined) throw new Error("give either path (overwrite) or name (create)");
      if (typeof args.content !== "string") throw new Error("content must be text");
      this.options.scratch.write(args.path.trim(), args.content);
      return `Wrote ${args.path.trim()}; frames showing it update.`;
    }
    const notes: string[] = [];
    this.createScratch(args.name, args.content, [], notes);
    return notes[0]!;
  }
}

const done = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
