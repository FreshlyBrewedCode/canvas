import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileContent } from "../shared/protocol";
import { BoardMcp, type BoardCall } from "./board-mcp";
import { isScratchPath, Scratch } from "./scratch";

describe("BoardMcp", () => {
  const calls: BoardCall[] = [];
  let online = true;
  const files: Record<string, FileContent> = {
    "src/auth.ts": { kind: "text", text: "a\nb\nc\n" },
    ".env": { kind: "denied", reason: ".env is not shared: looks like a secret" },
  };
  const scratch = new Scratch(mkdtempSync(join(tmpdir(), "canvas-mcp-")));
  const mcp = new BoardMcp({
    read: (path) =>
      isScratchPath(path) ? scratch.read(path) : (files[path] ?? { kind: "missing" }),
    scratch,
    relay: (call) => {
      if (!online) return false;
      calls.push(call);
      // The host's browser answers a moment later; it refuses frame "gone".
      const ok = call.tool !== "close_frame" && (call.args as { frame?: string }).frame !== "gone";
      // A drawing comes back as an image too (ADR 0008).
      const images =
        call.tool === "view_frame" && (call.args as { frame?: string }).frame === "sketch"
          ? [{ data: "iVBORw0KGgo=", mimeType: "image/png" as const }]
          : [];
      setTimeout(() => mcp.result(call.callId, ok, `ran ${call.tool}`, images), 5);
      return true;
    },
    timeoutMs: 200,
    skills: [{ name: "code-tour", description: "Give a code tour. Use when asked for one." }],
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
    expect(body.result.instructions).toContain(
      "- code-tour: Give a code tour. Use when asked for one.",
    );
    expect(body.result.capabilities.tools).toBeDefined();
  });

  test("lists the board tools", async () => {
    const { body } = await rpc("tools/list");
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "view_board",
      "view_frame",
      "open_frame",
      "update_frame",
      "close_frame",
      "read_board_file",
      "write_board_file",
      "add_comment",
      "edit_comment",
      "delete_comment",
      "draw",
    ]);
  });

  test("relays a call to the host's browser, for the calling session", async () => {
    const result = await call("view_board", {});
    expect(result.content[0]!.text).toStartWith("ran view_board");
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

  test("add_comment carries the text of its lines, read from the shared set", async () => {
    const added = await call("add_comment", {
      frame: "f",
      path: "./src/auth.ts",
      start_line: 2,
      end_line: 3,
      body: "hm",
      quote: "forged",
    });
    expect(added.isError).toBeUndefined();
    expect(calls.at(-1)!.args).toEqual({
      frame: "f",
      path: "src/auth.ts",
      start_line: 2,
      end_line: 3,
      body: "hm",
      quote: "b\nc",
    });
    const one = await call("add_comment", {
      frame: "f",
      path: "src/auth.ts",
      start_line: 1,
      body: "x",
    });
    expect(one.isError).toBeUndefined();
    expect(calls.at(-1)!.args).toMatchObject({ start_line: 1, end_line: 1, quote: "a" });

    const before = calls.length;
    const past = await call("add_comment", {
      frame: "f",
      path: "src/auth.ts",
      start_line: 3,
      end_line: 4,
      body: "x",
    });
    expect(past.content[0]!.text).toContain("aren't in src/auth.ts: it has 3 lines");
    const secret = await call("add_comment", {
      frame: "f",
      path: ".env",
      start_line: 1,
      body: "x",
    });
    expect(secret.content[0]!.text).toContain("looks like a secret");
    const missing = await call("add_comment", {
      frame: "f",
      path: "gone.ts",
      start_line: 1,
      body: "x",
    });
    expect(missing.content[0]!.text).toContain("can't be commented on: missing");
    expect(calls.length).toBe(before);
  });

  test("content becomes a scratch file; the board only sees its path", async () => {
    const opened = await call("open_frame", {
      type: "file",
      name: "overview.md",
      content: "# Auth\n",
      title: "Auth",
    });
    expect(opened.isError).toBeUndefined();
    expect(opened.content[0]!.text).toContain("Wrote scratch file canvas:scratch/overview.md");
    expect(calls.at(-1)!.args).toEqual({
      type: "file",
      path: "canvas:scratch/overview.md",
      title: "Auth",
    });
    expect(scratch.read("canvas:scratch/overview.md")).toEqual({ kind: "text", text: "# Auth\n" });

    const again = await call("update_frame", { frame: "f", name: "overview.md", content: "# 2" });
    expect(again.content[0]!.text).toContain(
      "canvas:scratch/overview-2.md (overview.md was taken)",
    );
    expect(calls.at(-1)!.args).toMatchObject({ path: "canvas:scratch/overview-2.md" });
  });

  test("a scratch file is removed again when the board refuses the call", async () => {
    const refused = await call("update_frame", { frame: "gone", name: "orphan.md", content: "x" });
    expect(refused.isError).toBe(true);
    expect(scratch.list()).not.toContain("canvas:scratch/orphan.md");
  });

  test("content needs a name, and can't come with a path", async () => {
    const before = calls.length;
    expect((await call("open_frame", { type: "file", content: "x" })).content[0]!.text).toContain(
      "needs a name",
    );
    const both = await call("open_frame", {
      type: "file",
      path: "a.md",
      name: "a.md",
      content: "x",
    });
    expect(both.content[0]!.text).toContain("not both");
    expect(calls.length).toBe(before);
  });

  test("list entries: paths checked, content becomes scratch files", async () => {
    const denied = await call("open_frame", {
      type: "file",
      files: [
        { display: "a.md", content: "# a" },
        { display: "Secrets/.env", path: ".env" },
      ],
    });
    expect(denied.content[0]!.text).toContain("looks like a secret");
    expect(scratch.list()).not.toContain("canvas:scratch/a.md");

    const opened = await call("open_frame", {
      type: "file",
      files: [
        { display: "Tour/1 Overview.md", content: "# tour" },
        { display: "Tour/auth.ts", path: "src/auth.ts", start_line: 2 },
        { display: "Tour/flow.html", name: "tour-flow.html", content: "<p>flow</p>" },
      ],
    });
    expect(opened.content[0]!.text).toContain("canvas:scratch/1-Overview.md");
    expect(calls.at(-1)!.args).toEqual({
      type: "file",
      files: [
        { display: "Tour/1 Overview.md", path: "canvas:scratch/1-Overview.md" },
        { display: "Tour/auth.ts", path: "src/auth.ts", start_line: 2 },
        { display: "Tour/flow.html", path: "canvas:scratch/tour-flow.html" },
      ],
    });
  });

  test("read_board_file and write_board_file need no board", async () => {
    const before = calls.length;
    online = false;
    const created = await call("write_board_file", { name: "flow.html", content: "<p>1</p>" });
    expect(created.content[0]!.text).toContain("canvas:scratch/flow.html");
    await call("write_board_file", { path: "canvas:scratch/flow.html", content: "<p>2</p>" });
    expect((await call("read_board_file", { path: "canvas:scratch/flow.html" })).content).toEqual([
      { type: "text", text: "<p>2</p>" },
    ]);
    const missing = await call("read_board_file", { path: "canvas:scratch/nope.md" });
    expect(missing.isError).toBe(true);
    const repo = await call("read_board_file", { path: "src/auth.ts" });
    expect(repo.content[0]!.text).toContain("not a scratch file");
    const overwrite = await call("write_board_file", { path: "canvas:scratch/x.md", content: "" });
    expect(overwrite.content[0]!.text).toContain("doesn't exist");
    online = true;
    expect(calls.length).toBe(before);
  });

  test("view_board lists the scratch files", async () => {
    const text = (await call("view_board", {})).content[0]!.text;
    expect(text).toContain(
      "Scratch files: canvas:scratch/1-Overview.md, canvas:scratch/flow.html,",
    );
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

  test("passes a drawing's image on as image content", async () => {
    const result = await call("view_frame", { frame: "sketch" });
    expect(result.content).toEqual([
      { type: "text", text: "ran view_frame" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as never,
    ]);
    expect((await call("view_frame", { frame: "files" })).content).toHaveLength(1);
  });
});
