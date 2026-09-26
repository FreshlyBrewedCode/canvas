/**
 * Spike 07: can canvas hand an ACP agent its own tools, and prime it without
 * the priming showing up in the thread?
 *
 * Serves a minimal MCP server (streamable HTTP, stateless, JSON responses) and
 * passes it to the agent in `session/new`. Three hidden "codewords" test which
 * priming channels reach the model:
 *   - MCP `initialize` → `instructions`         (any MCP client that honours it)
 *   - the tool's description                     (every MCP client)
 *   - ACP `_meta.systemPrompt.append`            (claude-agent-acp only)
 *
 *   bun spikes/07-board-mcp.ts claude|opencode
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const which = process.argv[2] ?? "claude";
const TOKEN = crypto.randomUUID();
const log = (...args: unknown[]) => console.log(`[${which}]`, ...args);

// --- a minimal MCP server --------------------------------------------------

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};
const board = [{ id: "a1", type: "agent", title: "agent-1", x: 0, y: 0, w: 460, h: 620 }];

const tool = {
  name: "canvas",
  description:
    "Read and change the shared canvas board. Codeword in this description: TANGERINE-7. " +
    "`command` is one of: list (frames on the board), open_file (args.path).",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", enum: ["list", "open_file"] },
      args: { type: "object" },
    },
    required: ["command"],
  },
};

function answer(rpc: Rpc): unknown {
  switch (rpc.method) {
    case "initialize":
      return {
        protocolVersion: (rpc.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "canvas", version: "0.0.0" },
        instructions:
          "You are running inside a frame of a shared canvas. Codeword in the server instructions: PERIWINKLE-42.",
      };
    case "tools/list":
      return { tools: [tool] };
    case "tools/call": {
      const { name, arguments: args } = rpc.params as {
        name: string;
        arguments: { command: string; args?: { path?: string } };
      };
      if (name !== "canvas") throw new Error(`no tool ${name}`);
      if (args.command === "open_file") {
        board.push({
          id: "f1",
          type: "file",
          title: args.args?.path ?? "?",
          x: 480,
          y: 0,
          w: 720,
          h: 560,
        });
        return { content: [{ type: "text", text: `opened ${args.args?.path} as frame f1` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(board) }] };
    }
    case "ping":
      return {};
    default:
      throw new Error(`unsupported ${rpc.method}`);
  }
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    log(
      "mcp",
      req.method,
      url.pathname,
      "auth:",
      req.headers.get("authorization") === `Bearer ${TOKEN}`
        ? "ok"
        : req.headers.get("authorization"),
    );
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
      return new Response("no", { status: 401 });
    const body = (await req.json()) as Rpc | Rpc[];
    const rpcs = Array.isArray(body) ? body : [body];
    const replies = rpcs.flatMap((rpc) => {
      log("  ←", rpc.method, rpc.method === "tools/call" ? JSON.stringify(rpc.params) : "");
      if (rpc.id === undefined) return [];
      try {
        return [{ jsonrpc: "2.0", id: rpc.id, result: answer(rpc) }];
      } catch (error) {
        return [{ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: String(error) } }];
      }
    });
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  },
});
const mcpUrl = `http://127.0.0.1:${server.port}/mcp/session-a1`;

// --- the agent over ACP ----------------------------------------------------

const cwd = `${import.meta.dir}/acp-workdir`;
await Bun.$`mkdir -p ${cwd}`;
const claudeBin = Bun.resolveSync(
  "@agentclientprotocol/claude-agent-acp/dist/index.js",
  import.meta.dir,
);
const cmd = which === "claude" ? ["bun", claudeBin] : ["opencode", "acp"];
const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd });

let text = "";
const seen: string[] = [];
const conn = new ClientSideConnection(
  () => ({
    requestPermission: async (params) => {
      log("PERMISSION asked:", params.toolCall.title, params.options.map((o) => o.kind).join(","));
      const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]!;
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    },
    sessionUpdate: async ({ update }) => {
      const u = update as { sessionUpdate: string; content?: { text?: string }; title?: string };
      seen.push(JSON.stringify(u));
      if (u.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
      if (u.sessionUpdate === "tool_call") log("tool_call:", u.title);
    },
  }),
  ndJsonStream(new WritableStream({ write: (c) => void proc.stdin.write(c) }), proc.stdout),
);

const init = await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
log("mcpCapabilities:", JSON.stringify(init.agentCapabilities?.mcpCapabilities));

const session = await conn.newSession({
  cwd,
  mcpServers: [
    {
      type: "http",
      name: "canvas",
      url: mcpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
    },
  ],
  _meta: {
    systemPrompt: { append: "Codeword in the appended system prompt: OBSIDIAN-3." },
    claudeCode: { options: { allowedTools: ["mcp__canvas__canvas"] } },
  },
});
log("session", session.sessionId);

const t0 = Date.now();
const response = await conn.prompt({
  sessionId: session.sessionId,
  prompt: [
    {
      type: "text",
      text:
        "Two things. 1) Quote every codeword (WORD-number) you were given anywhere in your instructions, " +
        "system prompt, MCP server instructions or tool descriptions, and say where each came from. " +
        "2) Use the canvas tool to list the board, then open the file README.md on it. Reply briefly.",
    },
  ],
});
log("stop:", response.stopReason, `${Date.now() - t0}ms`);
log("reply:\n" + text);
const leaked = seen.filter(
  (s) => /OBSIDIAN|PERIWINKLE/.test(s) && !s.includes("agent_message_chunk"),
);
log(
  "priming visible in non-message updates:",
  leaked.length ? leaked.map((s) => s.slice(0, 200)) : "no",
);

proc.kill();
server.stop();
process.exit(0);
