import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry, Message } from "./cassette";
import { Ids, withoutIds } from "./ids";

const CASSETTE = join(import.meta.dir, "cassette.ts");

describe("Ids", () => {
  test("pairs the ids in the same places, and puts this run's in", () => {
    const ids = new Ids();
    ids.learn(
      { url: "http://127.0.0.1:1/mcp/a1b2c3d4", text: "frame 0f0f0f0f in cluster 12345678" },
      { url: "http://127.0.0.1:2/mcp/ffff0000", text: "frame 9a9a9a9a in cluster 87654321" },
    );
    expect(ids.apply({ frame: "a1b2c3d4", list: ["0f0f0f0f", "12345678"] })).toEqual({
      frame: "ffff0000",
      list: ["9a9a9a9a", "12345678"],
    });
  });

  test("whole UUIDs too; a string whose ids don't line up teaches nothing", () => {
    const ids = new Ids();
    ids.learn("abcdef01-2345-6789-abcd-ef0123456789 and 0a0a0a0a", "only 0b0b0b0b");
    ids.learn("abcdef01-2345-6789-abcd-ef0123456789", "fedcba98-7654-3210-fedc-ba9876543210");
    expect(ids.apply("abcdef01-2345-6789-abcd-ef0123456789 0a0a0a0a")).toBe(
      "fedcba98-7654-3210-fedc-ba9876543210 0a0a0a0a",
    );
  });

  test("withoutIds blanks ids, not numbers", () => {
    expect(withoutIds("open a1b2c3d4 at 12345678")).toBe("open <id> at 12345678");
  });
});

/** A recording, as `record` writes it: canvas's frame a1b2c3d4, the agent's session s-1. */
const RECORDED: Entry[] = [
  { t: 0, dir: "in", msg: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} } },
  {
    t: 5,
    dir: "out",
    msg: { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, agentCapabilities: {} } },
  },
  {
    t: 6,
    dir: "in",
    msg: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/recorded",
        mcpServers: [
          { type: "http", name: "canvas", url: "http://127.0.0.1:1/mcp/a1b2c3d4", headers: [] },
        ],
      },
    },
  },
  { t: 9, dir: "out", msg: { jsonrpc: "2.0", id: 1, result: { sessionId: "s-1" } } },
  {
    t: 10,
    dir: "in",
    msg: {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text: "Look at a1b2c3d4" }] },
    },
  },
  {
    t: 400,
    dir: "out",
    msg: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Looking at a1b2c3d4" },
        },
      },
    },
  },
  {
    t: 500,
    dir: "mcp",
    server: "canvas",
    req: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "view_frame", arguments: { frame: "a1b2c3d4" } },
    },
    res: {
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "opened 0d0d0d0d" }] },
    },
  },
  {
    t: 501,
    dir: "mcp",
    server: "canvas",
    req: {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "close_frame", arguments: { frame: "0d0d0d0d" } },
    },
    res: { jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "closed" }] } },
  },
  {
    t: 600,
    dir: "out",
    msg: {
      jsonrpc: "2.0",
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "t1", title: "Write a file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    },
  },
  {
    t: 900,
    dir: "in",
    msg: { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "allow" } } },
  },
  { t: 950, dir: "out", msg: { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } } },
];

/** The board's MCP server, as this run has it: what was called, and its answers. */
let board: ReturnType<typeof Bun.serve>;
const calls: Array<{ path: string; auth: string | null; body: any }> = [];
beforeAll(() => {
  board = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as any;
      calls.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body,
      });
      const text = body.params.name === "view_frame" ? "opened 0e0e0e0e" : "closed";
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text }] },
      });
    },
  });
});
afterAll(() => board.stop(true));

/** canvas's side: start `command`, open a session on frame ffff0000, prompt, allow. */
async function drive(command: string[], text = "Look at ffff0000") {
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const updates: SessionNotification[] = [];
  const asked: string[] = [];
  const acp = new ClientSideConnection(
    () => ({
      sessionUpdate: async (n) => void updates.push(n),
      requestPermission: async (p) => {
        asked.push(p.toolCall.title ?? "");
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    }),
    ndJsonStream(
      new WritableStream<Uint8Array>({
        write: (chunk) => {
          child.stdin.write(chunk);
          void child.stdin.flush();
        },
      }),
      child.stdout,
    ),
  );
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await acp.newSession({
    cwd: "/replayed",
    mcpServers: [
      {
        type: "http",
        name: "canvas",
        url: `http://127.0.0.1:${board.port}/mcp/ffff0000`,
        headers: [{ name: "Authorization", value: "Bearer this-run" }],
      },
    ],
  });
  const result = await acp
    .prompt({ sessionId, prompt: [{ type: "text", text }] })
    .catch((error: { message?: string }) => ({ stopReason: `error: ${error.message}` }));
  child.kill();
  return { sessionId, result, updates, asked };
}

const scratch = () => mkdtempSync(join(tmpdir(), "cassette-test-"));

describe("replay", () => {
  test("answers as the agent did, asks its permissions, calls the board with this run's ids", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "claude-0.jsonl"), RECORDED.map((e) => JSON.stringify(e)).join("\n"));
    calls.length = 0;
    const run = await drive(["bun", CASSETTE, "replay", dir, scratch(), "claude", "--", "x"]);
    expect(run.sessionId).toBe("s-1");
    expect(run.result.stopReason).toBe("end_turn");
    expect(run.asked).toEqual(["Write a file"]);
    const said = run.updates.map((n) => (n.update as any).content?.text);
    expect(said).toEqual(["Looking at ffff0000"]);
    expect(calls.map((c) => [c.path, c.auth, c.body.params.arguments.frame])).toEqual([
      ["/mcp/ffff0000", "Bearer this-run", "ffff0000"],
      // The frame the first call opened, as this run named it.
      ["/mcp/ffff0000", "Bearer this-run", "0e0e0e0e"],
    ]);
    rmSync(dir, { recursive: true });
  });

  test("a prompt other than the recorded one fails, saying to rerecord", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "claude-0.jsonl"), RECORDED.map((e) => JSON.stringify(e)).join("\n"));
    const run = await drive(
      ["bun", CASSETTE, "replay", dir, scratch(), "claude", "--", "x"],
      "Something else",
    );
    expect(run.result.stopReason).toContain("rerecord");
  });
});

describe("record", () => {
  test("writes down what the agent and canvas said, and the agent's board calls", async () => {
    // The agent recorded here is the replay of the recording above.
    const source = scratch();
    writeFileSync(
      join(source, "claude-0.jsonl"),
      RECORDED.map((e) => JSON.stringify(e)).join("\n"),
    );
    const out = scratch();
    calls.length = 0;
    const run = await drive([
      "bun",
      CASSETTE,
      "record",
      out,
      scratch(),
      "claude",
      "--",
      ...["bun", CASSETTE, "replay", source, scratch(), "claude", "--", "x"],
    ]);
    expect(run.result.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(2);
    const entries = readFileSync(join(out, "claude-0.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);
    expect(
      entries.map((e) => (e.dir === "mcp" ? "mcp" : `${e.dir} ${e.msg.method ?? "result"}`)),
    ).toEqual([
      "in initialize",
      "out result",
      "in session/new",
      "out result",
      "in session/prompt",
      "out session/update",
      "mcp",
      "mcp",
      "out session/request_permission",
      "in result",
      "out result",
    ]);
    // canvas's own MCP server is what it wrote down, not the proxy the agent saw.
    const created = entries[2] as Entry & Message;
    expect(created.msg.params.mcpServers[0].url).toBe(
      `http://127.0.0.1:${board.port}/mcp/ffff0000`,
    );
  });
});
