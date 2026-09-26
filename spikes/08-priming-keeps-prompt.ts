/**
 * Spike 08: does priming an agent (MCP server `instructions`, Claude's
 * `_meta.systemPrompt`) keep the agent's own system prompt, or replace it?
 *
 * Asks the same self-description question under each variant and prints the
 * answers side by side. `replace` (a string system prompt) is the control:
 * it is documented to drop Claude Code's prompt.
 *
 *   [PROBE=opening] bun spikes/08-priming-keeps-prompt.ts claude|opencode baseline|mcp|append|replace
 *
 * The default probe asks what the agent is and can do; `opening` asks for the
 * system prompt's own opening lines and headings, which only the system prompt
 * can answer (tool descriptions and injected context survive a replacement).
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const which = process.argv[2] ?? "claude";
const variant = process.argv[3] ?? "baseline";
const PRIMING =
  "You are running inside an agent frame on canvas, a shared multiplayer board. " +
  "People watch the board live. Use the canvas tool to see and change it.";

// A minimal MCP server (see spike 07), only when the variant uses it.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const rpc = (await req.json()) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "canvas", version: "0.0.0" },
            instructions: PRIMING,
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "canvas",
                  description: "Read and change the shared canvas board.",
                  inputSchema: { type: "object", properties: { command: { type: "string" } } },
                },
              ],
            }
          : {};
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  },
});

const cwd = `${import.meta.dir}/acp-workdir`;
await Bun.$`mkdir -p ${cwd}`;
const claudeBin = Bun.resolveSync(
  "@agentclientprotocol/claude-agent-acp/dist/index.js",
  import.meta.dir,
);
const proc = Bun.spawn(which === "claude" ? ["bun", claudeBin] : ["opencode", "acp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
  cwd,
});
let text = "";
const conn = new ClientSideConnection(
  () => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
        text += update.content.text;
    },
  }),
  ndJsonStream(new WritableStream({ write: (c) => void proc.stdin.write(c) }), proc.stdout),
);
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
const session = await conn.newSession({
  cwd,
  mcpServers:
    variant === "baseline"
      ? []
      : [{ type: "http", name: "canvas", url: `http://127.0.0.1:${server.port}/mcp`, headers: [] }],
  ...(variant === "append" && { _meta: { systemPrompt: { append: PRIMING } } }),
  ...(variant === "replace" && { _meta: { systemPrompt: PRIMING } }),
});
await conn.prompt({
  sessionId: session.sessionId,
  prompt: [
    {
      type: "text",
      text:
        process.env.PROBE === "opening"
          ? "Without using any tools: quote verbatim the first two sentences of your system prompt, " +
            "then list the markdown section headings (lines starting with #) that appear in it, in order. " +
            "Then quote verbatim any text in your context that mentions a canvas or a board, and say which block it is in."
          : "Without using any tools, answer tersely in a numbered list: " +
            "1) What are you — product name and who makes it? " +
            "2) Your working directory, platform and today's date, as your instructions state them. " +
            "3) The names of every tool you can call. " +
            "4) Three concrete rules from your instructions about coding or git work (quote short phrases). " +
            "5) Anything your instructions say about a canvas or a board.",
    },
  ],
});
console.log(
  `===== ${which} / ${variant} / ${process.env.PROBE ?? "default"} =====\n${text.trim()}\n`,
);
proc.kill();
server.stop();
process.exit(0);
