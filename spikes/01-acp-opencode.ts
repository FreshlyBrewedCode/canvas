// Spike 1: can @tanstack/ai-acp's `acpCompatible` drive `opencode acp` on the
// host via localProcessSandbox, stream AG-UI chunks, resume a session for a
// second turn, and route permission prompts through an async handler?
import { chat } from "@tanstack/ai";
import { acpCompatible } from "@tanstack/ai-acp";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";

const dir = new URL("./acp-workdir", import.meta.url).pathname;
const agent = process.argv[2] ?? "opencode";

const harness = acpCompatible({
  name: agent,
  command: ({ harnessCwd }) =>
    agent === "claude" ? `bunx @agentclientprotocol/claude-agent-acp` : `opencode acp --cwd ${harnessCwd}`,
  cwd: dir,
  authMode: "host",
  env:
    agent === "opencode"
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "opencode-go/big-pickle", permission: { edit: "ask", bash: "ask" } }) }
      : undefined,
  onPermissionRequest: async (request) => {
    console.log("\n[PERMISSION]", request.toolCall.title, request.options.map((o) => `${o.optionId}:${o.kind}`));
    await new Promise((r) => setTimeout(r, 500));
    const allow = request.options.find((o) => o.kind === "allow_once") ?? request.options[0]!;
    return { outcome: "selected", optionId: allow.optionId };
  },
});

const sandbox = defineSandbox({
  id: `spike-${agent}`,
  provider: localProcessSandbox({ dir }),
  workspace: defineWorkspace({ source: { type: "none" }, setup: [] }),
  lifecycle: { reuse: "thread", destroyOnComplete: false },
});

async function turn(prompt: string, sessionId?: string) {
  let sid: string | undefined;
  const t0 = Date.now();
  const types = new Map<string, number>();
  for await (const chunk of chat({
    adapter: harness("default"),
    threadId: `spike-${agent}`,
    messages: [{ role: "user", content: prompt }],
    modelOptions: sessionId ? { sessionId } : {},
    middleware: [withSandbox(sandbox)],
  }) as AsyncIterable<any>) {
    types.set(chunk.type, (types.get(chunk.type) ?? 0) + 1);
    if (chunk.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(chunk.delta);
    else if (chunk.type === "CUSTOM") {
      console.log("\n[CUSTOM]", chunk.name, JSON.stringify(chunk.value).slice(0, 200));
      if (chunk.name.endsWith(".session-id")) sid = chunk.value.sessionId;
    } else if (chunk.type.startsWith("TOOL_CALL_START")) console.log("\n[TOOL]", chunk.toolName ?? chunk.toolCallName);
    else if (chunk.type === "RUN_ERROR") console.log("\n[ERROR]", chunk.message ?? chunk);
  }
  console.log(`\n--- ${Date.now() - t0}ms`, Object.fromEntries(types));
  return sid;
}

const sid = await turn("Create a file called notes.md containing a haiku about canvases. Then reply with just 'done'.");
console.log("session:", sid);
await turn("What was the name of the file you just created? Answer with only the file name.", sid);
process.exit(0);
