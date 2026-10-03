// The life of an agent process (ADR 0012), against a stand-in ACP agent
// (`fake-acp-agent.ts`): a kind's settings listed once, a session begun by
// its first prompt, stopped once no frame shows it, and resumed after.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentConfigOption,
  AgentEvent,
  KindOptions,
  SessionMeta,
  SessionSnapshot,
} from "../shared/protocol";
import { AgentManager } from "./agents";

const author = { name: "Ada", color: "#000" };
const managers: AgentManager[] = [];
afterEach(() => managers.splice(0).forEach((m) => m.close()));

function setup({
  caps = { close: {}, resume: {} } as Record<string, object>,
  restored = [] as SessionSnapshot[],
  kindOptions = {} as KindOptions,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "canvas-agents-"));
  const logPath = join(dir, "calls.ndjson");
  const metas: SessionMeta[] = [];
  const events: Array<{ sessionId: string; event: AgentEvent }> = [];
  const kinds: Array<{ agent: string; options: ReadonlyArray<AgentConfigOption> }> = [];
  const options: Array<ReadonlyArray<AgentConfigOption>> = [];
  const errors: string[] = [];
  const agents = new AgentManager({
    dir,
    agents: [
      {
        kind: "fake",
        label: "Fake",
        command: ["bun", join(import.meta.dir, "fake-acp-agent.ts")],
        env: { FAKE_ACP_LOG: logPath, FAKE_ACP_CAPS: JSON.stringify(caps) },
      },
    ],
    restored,
    kindOptions,
    onMeta: (meta) => metas.push(meta),
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
    onOptions: (_, listed) => options.push(listed),
    onKindOptions: (agent, options) => kinds.push({ agent, options }),
    onError: (message) => errors.push(message),
  });
  managers.push(agents);
  const calls = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number; method: string; params: any })
      : [];
  const methods = () => calls().map((c) => c.method);
  return { agents, metas, events, kinds, options, errors, calls, methods };
}

const until = async (what: string, test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a kind's settings: its agent runs once to list them, and stops", async () => {
  const { agents, kinds, calls, methods } = setup();
  agents.probe("fake");
  agents.probe("fake");
  await until("listed", () => kinds.length > 0);
  expect(kinds[0]!.agent).toBe("fake");
  expect(kinds[0]!.options.map((o) => `${o.id}=${o.value}`)).toEqual(["model=small", "effort=low"]);
  expect(agents.kindOptions().fake).toEqual(kinds[0]!.options);
  await until("closed", () => methods().includes("session/close"));
  expect(methods()).toEqual(["initialize", "session/new", "session/close"]);
  const pid = calls()[0]!.pid;
  await until("stopped", () => !alive(pid));
  // Known now: no process again.
  agents.probe("fake");
  await Bun.sleep(200);
  expect(methods()).toHaveLength(3);
});

test("the first prompt begins the session in its frame, with the settings it starts from", async () => {
  const { agents, metas, events, methods } = setup({
    kindOptions: {
      fake: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          value: "small",
          choices: [
            { value: "small", name: "Small" },
            { value: "large", name: "Large" },
          ],
        },
      ],
    },
  });
  expect(agents.heads()).toEqual([]);
  agents.prompt({
    sessionId: "s1",
    frameId: "f1",
    agent: "fake",
    settings: [{ id: "model", value: "large" }],
    text: "Explain the layout\nin detail",
    author,
  });
  // Begun at once, with what it will start with.
  expect(metas[0]).toMatchObject({ id: "s1", agent: "fake", frameId: "f1", status: "idle" });
  expect(metas[0]!.settings?.map((s) => s.label)).toEqual(["Large"]);
  expect(agents.frameOf("s1")).toBe("f1");
  await until("turn over", () => events.some((e) => e.event.kind === "turn-end"));
  const turn = events.find((e) => e.event.kind === "turn")!.event;
  expect(turn).toMatchObject({
    kind: "turn",
    frameId: "f1",
    text: "Explain the layout\nin detail",
  });
  const last = agents.heads()[0]!.meta;
  expect(last).toMatchObject({ status: "idle", title: "Explain the layout" });
  expect(last.lastAt).toBeGreaterThanOrEqual(last.createdAt);
  expect(last.settings?.find((s) => s.id === "model")?.value).toBe("large");
  expect(methods()).toEqual([
    "initialize",
    "session/new",
    "session/set_config_option",
    "session/prompt",
  ]);

  // Another frame prompts it: the agent acts as that one now.
  agents.prompt({ sessionId: "s1", frameId: "f2", agent: "fake", text: "again", author });
  expect(agents.frameOf("s1")).toBe("f2");
  await until("second turn", () => events.filter((e) => e.event.kind === "turn-end").length > 1);
  expect(agents.heads()[0]!.meta.title).toBe("Explain the layout");
  expect(agents.history("s1")?.filter((e) => e.kind === "turn")).toHaveLength(2);
});

test("released, it closes and stops; prompted again, it resumes the agent's session", async () => {
  const { agents, events, calls, methods } = setup();
  agents.prompt({ sessionId: "s1", frameId: "f1", agent: "fake", text: "hi", author });
  await until("turn over", () => events.some((e) => e.event.kind === "turn-end"));
  const first = calls()[0]!.pid;
  const acpSessionId = agents.heads()[0]!.meta.acpSessionId;
  expect(acpSessionId).toBeString();

  agents.release("s1");
  await until("stopped", () => !alive(first));
  expect(methods().at(-1)).toBe("session/close");

  agents.prompt({ sessionId: "s1", frameId: "f1", agent: "fake", text: "again", author });
  await until("second turn", () => events.filter((e) => e.event.kind === "turn-end").length > 1);
  const second = calls().filter((c) => c.pid !== first);
  expect(second.map((c) => c.method)).toEqual(["initialize", "session/resume", "session/prompt"]);
  expect(second[1]!.params.sessionId).toBe(acpSessionId);
});

test("an agent without resume or close: loaded again, and just stopped", async () => {
  const { agents, events, calls } = setup({ caps: {} });
  agents.prompt({ sessionId: "s1", frameId: "f1", agent: "fake", text: "hi", author });
  await until("turn over", () => events.some((e) => e.event.kind === "turn-end"));
  const first = calls()[0]!.pid;
  agents.release("s1");
  await until("stopped", () => !alive(first));
  agents.prompt({ sessionId: "s1", frameId: "f1", agent: "fake", text: "again", author });
  await until("second turn", () => events.filter((e) => e.event.kind === "turn-end").length > 1);
  expect(calls().map((c) => c.method)).toEqual([
    "initialize",
    "session/new",
    "session/prompt",
    "initialize",
    "session/load",
    "session/prompt",
  ]);
});

test("a setting changed before the first prompt begins the session there", async () => {
  const { agents, metas, options, methods } = setup();
  await expect(agents.configure("s1", "effort", "high")).rejects.toThrow("no session s1");
  await agents.configure("s1", "effort", "high", { frameId: "f1", agent: "fake" });
  expect(metas[0]).toMatchObject({ id: "s1", frameId: "f1" });
  expect(agents.heads()[0]!.options?.find((o) => o.id === "effort")?.value).toBe("high");
  expect(agents.heads()[0]!.meta.title).toBeUndefined();
  expect(methods()).toEqual(["initialize", "session/new", "session/set_config_option"]);
  // One answer, the change's: not the agent's defaults before it.
  expect(options.map((o) => o.find((x) => x.id === "effort")?.value)).toEqual(["high"]);
});

test("restored sessions act as their last turn's frame", () => {
  const meta: SessionMeta = {
    id: "s1",
    agent: "fake",
    status: "running",
    frameId: "f1",
    createdAt: 1,
    lastAt: 2,
  };
  const { agents } = setup({
    restored: [
      {
        meta,
        events: [{ kind: "turn", turnId: "t", text: "x", author, at: 1, frameId: "f9" }],
      },
    ],
  });
  expect(agents.frameOf("s1")).toBe("f9");
  expect(agents.heads()).toEqual([{ meta: { ...meta, status: "idle" } }]);
});
