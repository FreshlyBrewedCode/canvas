/**
 * Spike 02: what do ACP agents advertise about models / reasoning / context,
 * and can a client change it? Talks ACP directly (SDK 0.25, what ai-acp uses).
 *
 *   bun spikes/02-acp-config-options.ts claude|opencode [configId=value ...]
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const which = process.argv[2] ?? "claude";
const sets = process.argv.slice(3).map((a) => a.split("=") as [string, string]);
const claudeBin = Bun.resolveSync("@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.dir);
const cmd = which === "claude" ? ["bun", claudeBin] : ["opencode", "acp"];
const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: `${import.meta.dir}/acp-workdir` });

const writable = new WritableStream<Uint8Array>({ write: (c) => void proc.stdin.write(c) });
const conn = new ClientSideConnection(
  () => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async (n) => {
      const u = n.update as { sessionUpdate: string };
      if (u.sessionUpdate !== "available_commands_update") console.log("update:", JSON.stringify(u).slice(0, 400));
    },
  }),
  ndJsonStream(writable, proc.stdout),
);
const t0 = Date.now();
const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
console.log("init", Date.now() - t0, "ms", JSON.stringify(init.agentCapabilities));
const session = await conn.newSession({ cwd: `${import.meta.dir}/acp-workdir`, mcpServers: [] });
console.log("newSession", Date.now() - t0, "ms");
const { configOptions, models, modes } = session as Record<string, unknown>;
type Opt = { id: string; category?: string; currentValue: unknown; options: Array<{ value: string; name: string; description?: string }> };
const summarize = (opts: Opt[]) =>
  opts.map((o) => `  ${o.id} [${o.category}] = ${o.currentValue} (${o.options.length}): ${o.options.slice(0, 8).map((x) => x.value).join(", ")}`).join("\n");
console.log("configOptions:\n" + summarize(configOptions as Opt[]));
console.log("models (unstable):", JSON.stringify(models)?.slice(0, 1500));
console.log("modes:", JSON.stringify(modes)?.slice(0, 600));
for (const [configId, value] of sets) {
  const r = await conn.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
  console.log(`set ${configId}=${value} →`, "\n" + summarize(r.configOptions as Opt[]));
}
if (process.env.PROMPT) {
  const r = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: process.env.PROMPT }] });
  console.log("prompt →", JSON.stringify(r));
}
proc.kill();
await Bun.sleep(100);
process.exit(0);
