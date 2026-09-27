/**
 * Spike 10: with canvas's skills passed and named in the board priming, does
 * an agent load `code-tour` when asked for a tour, with the host's own skills
 * (dozens) beside it? A stub board MCP server records the board calls.
 *
 * Wants /tmp/tour-proj: a git repo with src/route.ts calling src/auth.ts.
 *
 *   bun spikes/10-skill-priming.ts claude|opencode
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { BOARD_TOOLS, boardInstructions } from "../src/shared/board-tools";
import { canvasSkills, SKILLS_DIR } from "../src/server/skills";
const which = process.argv[2]!;
const seen: string[] = [];
const server = Bun.serve({ port: 0, async fetch(req) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const rpc = (await req.json()) as any;
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  const result = rpc.method === "initialize" ? { protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "canvas", version: "0" }, instructions: boardInstructions("f1", canvasSkills()) }
    : rpc.method === "tools/list" ? { tools: BOARD_TOOLS }
    : rpc.method === "tools/call" ? (seen.push(`${rpc.params.name} ${JSON.stringify(rpc.params.arguments).slice(0, 300)}`), { content: [{ type: "text", text: "done: frame f2" }] }) : {};
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
}});
const claudeBin = Bun.resolveSync("@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.dir);
const cwd = "/tmp/tour-proj";
const proc = Bun.spawn(which === "claude" ? ["bun", claudeBin] : ["opencode", "acp"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd,
  env: { ...process.env, ...(which === "opencode" && { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [SKILLS_DIR] } }) }) } });
const tools: string[] = []; let text = "";
const conn = new ClientSideConnection(() => ({
  requestPermission: async ({ options }) => ({ outcome: { outcome: "selected", optionId: (options.find((o) => o.kind === "allow_once") ?? options[0])!.optionId } }),
  sessionUpdate: async ({ update }) => { if (update.sessionUpdate === "tool_call") tools.push(update.title);
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text; },
}), ndJsonStream(new WritableStream({ write: (c) => void proc.stdin.write(c) }), proc.stdout));
await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
const s: any = await conn.newSession({ cwd, mcpServers: [{ type: "http", name: "canvas", url: `http://127.0.0.1:${server.port}/mcp`, headers: [] }],
  ...(which === "claude" && { _meta: { claudeCode: { options: { plugins: [{ type: "local", path: SKILLS_DIR, skipMcpDiscovery: true }] } } } }) });
console.log("model:", JSON.stringify(s.configOptions?.find((o: any) => o.id === "model")?.currentValue));
await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Give us a code tour of how login works here." }] });
console.log(`===== ${which}\ntools: ${tools.join(" | ")}\nboard calls:\n${seen.join("\n")}\nreply: ${text.trim()}\n`);
proc.kill(); process.exit(0);
