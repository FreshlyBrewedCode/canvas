import { afterAll, describe, expect, test } from "bun:test";

import type { FileContent } from "../shared/protocol";
import { BoardMcp, type BoardCall } from "./board-mcp";

describe("BoardMcp", () => {
  const calls: BoardCall[] = [];
  let online = true;
  const files: Record<string, FileContent> = {
    "src/auth.ts": { kind: "text", text: "a\nb\nc\n" },
    ".env": { kind: "denied", reason: ".env is not shared: looks like a secret" },
  };
  const mcp = new BoardMcp({
    read: (path) => files[path] ?? { kind: "missing" },
    relay: (call) => {
      if (!online) return false;
      calls.push(call);
      // The host's browser answers a moment later.
      setTimeout(() => mcp.result(call.callId, call.tool !== "close_frame", `ran ${call.tool}`), 5);
      return true;
    },
    timeoutMs: 200,
  });
  afterAll(() => mcp.stop());

  const server = mcp.serverFor("frame1");
  const auth = server.headers.find((h) => h.name === "Authorization")!.value;
  let id = 0;
  const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const call = async (name: string, args: unknown) =>
    (await rpc("tools/call", { name, arguments: args })).body.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

  test("refuses requests without the session's secret", async () => {
    const other = mcp.serverFor("frame2").headers[0]!.value;
    expect((await rpc("tools/list", undefined, { authorization: other })).status).toBe(401);
    expect((await rpc("tools/list", undefined, { authorization: "Bearer x" })).status).toBe(401);
  });

  test("initialize carries the priming as instructions", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.instructions).toContain("frame frame1");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  test("lists the board tools", async () => {
    const { body } = await rpc("tools/list");
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "view_board",
      "open_frame",
      "update_frame",
      "close_frame",
    ]);
  });

  test("relays a call to the host's browser, for the calling session", async () => {
    const result = await call("view_board", {});
    expect(result).toEqual({ content: [{ type: "text", text: "ran view_board" }] });
    expect(calls.at(-1)).toMatchObject({ sessionId: "frame1", tool: "view_board", args: {} });
  });

  test("a failed call is a tool error, not a protocol error", async () => {
    expect(await call("close_frame", { frame: "x" })).toMatchObject({ isError: true });
  });

  test("checks file paths against the shared set before relaying", async () => {
    const before = calls.length;
    const denied = await call("open_frame", { type: "file", path: ".env" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("looks like a secret");
    const past = await call("open_frame", { type: "file", path: "src/auth.ts", start_line: 9 });
    expect(past.isError).toBe(true);
    expect(past.content[0]!.text).toContain("has 3 lines");
    expect(calls.length).toBe(before);

    const missing = await call("update_frame", { frame: "f", path: "docs/new.md" });
    expect(missing.content[0]!.text).toContain("doesn't exist yet");
    expect(calls.length).toBe(before + 1);
  });

  test("says so when the board isn't open", async () => {
    online = false;
    const result = await call("view_board", {});
    online = true;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("host's browser");
  });

  test("notifications are accepted without a reply", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(response.status).toBe(202);
  });
});
