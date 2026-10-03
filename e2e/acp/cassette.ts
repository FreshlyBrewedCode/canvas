#!/usr/bin/env bun
/**
 * Record an ACP agent's session, or replay a recording in its place: the e2e
 * tests' agents (`e2e/agents.ts`). `canvas serve` puts every agent's command
 * behind `CANVAS_AGENT_WRAPPER` (`src/server/agents.ts`), so this runs as
 *
 *   cassette.ts record <cassettes> <state> <kind> -- <agent command…>
 *   cassette.ts replay <cassettes> <state> <kind> -- <agent command…>
 *
 * A cassette is one agent process's traffic, `<cassettes>/<kind>-<n>.jsonl`,
 * in the order it happened: ACP messages each way (`in` from canvas, `out`
 * from the agent) and the agent's calls to the board's MCP server (`mcp`),
 * which canvas hands it in `session/new` (or `/load`, `/resume`). Recording
 * runs the real agent, its MCP server swapped for a proxy here that writes
 * each call down. Replaying answers canvas as the agent did, waits for what
 * canvas sent, asks the permissions the agent asked, and makes the agent's MCP
 * calls itself — against this run's board, with this run's ids (`ids.ts`) —
 * so the board changes as it did.
 *
 * Processes take their cassettes in the order they start, per kind; `<state>`
 * holds which are taken, and is the run's own. The process `canvas serve`
 * starts only to list a kind's settings (its probe) is one like any other.
 */
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Ids, withoutIds } from "./ids";

export type Rpc = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
};
export type Message = { dir: "in" | "out"; msg: Rpc };
export type McpCall = { dir: "mcp"; server: string; req: unknown; res: unknown };
/** One line of a cassette; `t` is ms since the process started. */
export type Entry = (Message | McpCall) & { t: number };

type Server = { name: string; url: string; headers: Array<{ name: string; value: string }> };

/**
 * What a recording must not carry into the repo: where things are on the
 * recording machine, whose it is, the agent's account (Claude Code reports
 * its email). The same text out, whoever records.
 */
export function scrub(line: string): string {
  const user = userInfo().username;
  let out = line
    .replaceAll(resolve(import.meta.dir, "../.."), "<canvas>")
    .replaceAll(homedir(), "<home>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
  if (user.length >= 3) out = out.replace(new RegExp(`\\b${RegExp.escape(user)}\\b`, "g"), "user");
  return out;
}

/** The ACP requests that hand the agent its MCP servers. */
const OPENS_SESSION = new Set(["session/new", "session/load", "session/resume"]);

/** How long a replay waits between the agent's messages at most, in ms. */
const GAP = Number(process.env.CANVAS_REPLAY_GAP_MS ?? 25);

if (import.meta.main) {
  const [mode, cassettes, state, kind, dash, ...command] = process.argv.slice(2);
  if (!(mode === "record" || mode === "replay") || !cassettes || !state || !kind || dash !== "--")
    fail("usage: cassette.ts record|replay <cassettes> <state> <kind> -- <command…>");
  if (mode === "record") await record(cassettes!, state!, kind!, command);
  else await replay(cassettes!, state!, kind!);
}

/** The first `<kind>-<n>` not yet taken in this run. */
function claim(cassettes: string, state: string, kind: string, existing: boolean): string {
  for (let n = 0; ; n++) {
    const file = join(cassettes, `${kind}-${n}.jsonl`);
    if (existing && !existsSync(file))
      fail(
        `no recording left for ${kind} (${kind}-${n}.jsonl in ${cassettes}): ` +
          `rerecord with E2E_AGENTS=record`,
      );
    try {
      openSync(join(state, `${kind}-${n}`), "wx");
      return file;
    } catch {}
  }
}

async function record(cassettes: string, state: string, kind: string, command: string[]) {
  const file = claim(cassettes, state, kind, false);
  const start = Date.now();
  const write = (entry: Message | McpCall) =>
    appendFileSync(file, scrub(JSON.stringify({ t: Date.now() - start, ...entry })) + "\n");

  // The agent's MCP servers, behind a proxy that writes each call down.
  const servers: Server[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const server = servers[Number(new URL(req.url).pathname.slice(1))];
      if (!server) return new Response("not found", { status: 404 });
      const headers = new Headers(req.headers);
      headers.delete("host");
      const body = req.method === "POST" ? await req.text() : undefined;
      const res = await fetch(server.url, { method: req.method, headers, body });
      const text = await res.text();
      if (body) write({ dir: "mcp", server: server.name, req: parse(body), res: parse(text) });
      const out = new Headers(res.headers);
      out.delete("content-length");
      out.delete("content-encoding");
      return new Response(text, { status: res.status, headers: out });
    },
  });

  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  void (async () => {
    for await (const line of lines(Bun.stdin.stream())) {
      const msg = JSON.parse(line) as Rpc;
      let sent = msg;
      if (OPENS_SESSION.has(msg.method ?? "")) {
        const mcp = (msg.params?.mcpServers ?? []) as Server[];
        // The MCP server's secret is the run's own: not one for the repo.
        write({
          dir: "in",
          msg: {
            ...msg,
            params: {
              ...msg.params,
              mcpServers: mcp.map((server) => ({
                ...server,
                headers: server.headers?.map((h) => ({ ...h, value: "<redacted>" })),
              })),
            },
          },
        });
        sent = {
          ...msg,
          params: {
            ...msg.params,
            mcpServers: mcp.map((server) =>
              "url" in server
                ? { ...server, url: `http://127.0.0.1:${proxy.port}/${servers.push(server) - 1}` }
                : server,
            ),
          },
        };
      } else write({ dir: "in", msg });
      child.stdin.write(JSON.stringify(sent) + "\n");
      await child.stdin.flush();
    }
    await child.stdin.end();
  })();
  for await (const line of lines(child.stdout)) {
    write({ dir: "out", msg: JSON.parse(line) as Rpc });
    process.stdout.write(line + "\n");
  }
  process.exit(await child.exited);
}

async function replay(cassettes: string, state: string, kind: string) {
  const file = claim(cassettes, state, kind, true);
  const entries = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
  const ids = new Ids();
  const send = (msg: Rpc) => process.stdout.write(JSON.stringify(msg) + "\n");

  // What canvas sends, kept until the recording expects it.
  const inbox: Rpc[] = [];
  let wake = () => {};
  let closed = false;
  void (async () => {
    for await (const line of lines(Bun.stdin.stream())) {
      inbox.push(JSON.parse(line) as Rpc);
      wake();
    }
    closed = true;
    wake();
  })();
  const take = async (match: (msg: Rpc) => boolean): Promise<Rpc> => {
    for (;;) {
      const i = inbox.findIndex(match);
      if (i >= 0) return inbox.splice(i, 1)[0]!;
      if (closed) process.exit(0);
      await new Promise<void>((done) => (wake = done));
    }
  };

  const requests = new Map<unknown, Rpc["id"]>();
  const servers = new Map<string, Server>();
  let last = 0;
  let stopped: string | null = null;
  for (const entry of entries) {
    if (entry.dir === "in") {
      const { msg } = entry;
      if (msg.method === undefined) {
        // canvas's answer to the agent's request (a permission): any will do.
        await take((m) => m.method === undefined && m.id === msg.id);
        continue;
      }
      const actual = await take((m) => m.method === msg.method);
      ids.learn(msg.params, actual.params);
      if (msg.id !== undefined) requests.set(msg.id, actual.id);
      if (OPENS_SESSION.has(msg.method ?? ""))
        for (const server of (actual.params?.mcpServers ?? []) as Server[])
          if ("url" in server) servers.set(server.name, server);
      if (msg.method === "session/prompt") {
        const [want, got] = [promptText(msg), promptText(actual)];
        if (withoutIds(want) !== withoutIds(got)) {
          stopped =
            `canvas e2e: the prompt is not the recorded one — rerecord with E2E_AGENTS=record ` +
            `(${file}).\n  recorded: ${want}\n  sent:     ${got}`;
          console.error(stopped);
          send({ jsonrpc: "2.0", id: actual.id, error: { code: -32603, message: stopped } });
          break;
        }
      }
      continue;
    }
    // The agent's side: as it went, a little faster.
    await new Promise((r) => setTimeout(r, Math.min(Math.max(entry.t - last, 0), GAP)));
    last = entry.t;
    if (entry.dir === "mcp") {
      const server = servers.get(entry.server);
      if (!server) continue;
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      for (const { name, value } of server.headers) headers.set(name, value);
      const res = await fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify(ids.apply(entry.req)),
      }).catch((error: unknown) => {
        console.error(`canvas e2e: the board's MCP call failed: ${String(error)}`);
        return null;
      });
      if (res) ids.learn(entry.res, parse(await res.text()));
      continue;
    }
    // Ids in what it says are this run's; the message's own id stays: canvas
    // answers the agent's requests by it.
    const msg = ids.apply(entry.msg);
    if (entry.msg.id !== undefined) msg.id = entry.msg.id;
    if (msg.method === undefined && requests.has(entry.msg.id))
      send({ ...msg, id: requests.get(entry.msg.id) });
    else send(msg);
  }

  // The recording is over: anything canvas still asks, it can't answer.
  for (;;) {
    const msg = await take(() => true);
    if (msg.method !== undefined && msg.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message:
            stopped ??
            `canvas e2e: ${msg.method} is past the end of the recording — rerecord with E2E_AGENTS=record (${file})`,
        },
      });
  }
}

function promptText(msg: Rpc): string {
  const blocks = (msg.params?.prompt ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  const text = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>;
  for await (const chunk of stream.pipeThrough(text)) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
