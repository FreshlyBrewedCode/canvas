/**
 * Spike 09: can canvas hand an agent skills that live outside the project and
 * outside the user's config, per session?
 *
 * The skill (`spikes/skills/board-codeword/SKILL.md`) holds a codeword only
 * the skill body knows. `spikes/skills/` is both a Claude plugin (its manifest
 * points `skills` at the plugin root itself) and an opencode skills path.
 * Variants:
 *   - claude  `plugin`: `_meta.claudeCode.options.plugins` (a local plugin dir)
 *   - opencode `paths`: `OPENCODE_CONFIG_CONTENT` → `skills.paths`
 *   - either  `none`:   control, nothing passed
 *
 *   bun spikes/09-skills.ts claude|opencode plugin|paths|none
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const which = process.argv[2] ?? "claude";
const variant = process.argv[3] ?? "none";
const plugin = `${import.meta.dir}/skills`;

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
  env: {
    ...process.env,
    ...(which === "opencode" &&
      variant === "paths" && {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [plugin] } }),
      }),
  },
});
let text = "";
const tools: string[] = [];
const conn = new ClientSideConnection(
  () => ({
    requestPermission: async ({ toolCall, options }) => {
      tools.push(`asked: ${toolCall.title}`);
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      return { outcome: { outcome: "selected", optionId: allow!.optionId } };
    },
    sessionUpdate: async ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
        text += update.content.text;
      if (update.sessionUpdate === "tool_call") tools.push(update.title);
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
  mcpServers: [],
  ...(which === "claude" &&
    variant === "plugin" && {
      _meta: { claudeCode: { options: { plugins: [{ type: "local", path: plugin }] } } },
    }),
});
await conn.prompt({
  sessionId: session.sessionId,
  prompt: [
    {
      type: "text",
      text:
        "What is the canvas codeword? If you have a skill for it, use it. " +
        "Do not search files. Then list the names of all skills available to you.",
    },
  ],
});
console.log(
  `===== ${which} / ${variant} =====\ntools: ${tools.join(" | ") || "-"}\n${text.trim()}\n`,
);
proc.kill();
process.exit(0);
