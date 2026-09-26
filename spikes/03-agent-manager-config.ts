/**
 * Spike 03: AgentManager end to end against a real agent — options arrive on
 * create, settings change, a turn runs, and after the process is dropped the
 * reloaded session gets its settings back.
 *
 *   bun spikes/03-agent-manager-config.ts claude|opencode model=… effort=…
 */
import { AgentManager, detectAgents } from "../src/server/agents";
import type { AgentConfigOption } from "../src/shared/protocol";

const kind = process.argv[2] ?? "claude";
const sets = process.argv.slice(3).map((a) => a.split("=") as [string, string]);
let options: ReadonlyArray<AgentConfigOption> = [];
const live = () => (options = manager.snapshots()[0]?.options ?? options);
const show = () =>
  options.map((o) => `${o.id}=${String(o.value)}${o.type === "select" ? `/${o.choices.length}` : ""}`).join(" ");
const manager = new AgentManager({
  dir: `${import.meta.dir}/acp-workdir`,
  agents: detectAgents(),
  restored: [],
  onMeta: (meta) => meta.settings && console.log("meta settings:", meta.settings.map((s) => `${s.id}=${s.label}`).join(", ")),
  onEvent: (_, event) => event.kind !== "chunk" && console.log("event:", event.kind, "error" in event ? event.error : ""),
  onOptions: (_, next) => (options = next),
  onError: (message) => console.log("error:", message),
});
const until = async (what: string, test: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(100);
  }
};
const snapshot = () => manager.snapshots()[0]!;
const turnStart = () => (t = Date.now());

let t = Date.now();
manager.create("s1", kind);
await until("options", () => options.length > 0);
console.log(`options after ${Date.now() - t} ms:`, show());
for (const [id, value] of sets) {
  t = Date.now();
  await manager.configure("s1", id, value);
  console.log(`set ${id}=${value} in ${Date.now() - t} ms:`, show());
}
turnStart();
manager.prompt("s1", "Reply with exactly: pong. Also name the model you are, briefly.", { name: "spike", color: "#fff" });
await until("turn", () => snapshot().meta.status === "idle" && snapshot().events.some((e) => e.kind === "turn-end"), 120_000);
const text = snapshot().events
  .flatMap((e) => (e.kind === "chunk" && (e.chunk as { type: string }).type === "TEXT_MESSAGE_CONTENT" ? [(e.chunk as { delta: string }).delta] : []))
  .join("");
console.log(`turn 1 took ${Date.now() - t} ms`);
console.log("reply:", JSON.stringify(text.slice(0, 200)));

// Drop the process: the next turn reloads the session and restores settings.
manager.close();
await Bun.sleep(500);
options = [];
t = Date.now();
manager.prompt("s1", "Reply with exactly: ping", { name: "spike", color: "#fff" });
await until("turn 2", () => snapshot().events.filter((e) => e.kind === "turn-end").length === 2, 120_000);
live();
console.log(`second turn after reconnect ${Date.now() - t} ms; options now:`, show());
manager.close();
process.exit(0);
