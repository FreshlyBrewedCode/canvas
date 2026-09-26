/**
 * `canvas serve`: the local half of canvas. One WebSocket endpoint that only
 * the host's browser may use (it presents the token from the printed link).
 * Nothing here knows about guests — the host's browser is the relay.
 */

import type { ServerWebSocket } from "bun";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientToServer, ServerToClient } from "../shared/protocol";
import { AgentManager, detectAgents } from "./agents";
import { BoardMcp } from "./board-mcp";
import { Files } from "./files";
import { Scratch } from "./scratch";
import { Store } from "./store";
import { Terminals } from "./terminals";

export interface ServeOptions {
  readonly dir: string;
  readonly port: number;
  readonly hostname: string;
  readonly tls?: { readonly cert: string; readonly key: string };
}

export async function serve(options: ServeOptions) {
  const store = new Store(options.dir);
  excludeFromGit(options.dir);
  const room = await store.room();
  const clients = new Set<ServerWebSocket<unknown>>();
  const broadcast = (message: ServerToClient) => {
    const text = JSON.stringify(message);
    for (const ws of clients) ws.send(text);
  };

  // Scratch files are written by agents' board tools; `files` mirrors them.
  const scratch = new Scratch(options.dir, (path) => files.scratchChanged(path));
  const files = new Files(
    options.dir,
    (path, file) => broadcast({ t: "file", path, file }),
    (paths) => broadcast({ t: "tree", paths }),
    scratch,
  );
  process.on("exit", () => files.stop());
  // Board tools: an agent's call goes to one host browser (the board is there).
  const boardMcp = new BoardMcp({
    read: (path) => files.read(path),
    relay: (call) => {
      const [ws] = clients;
      if (!ws) return false;
      ws.send(JSON.stringify({ t: "board-call", ...call } satisfies ServerToClient));
      return true;
    },
  });
  process.on("exit", () => boardMcp.stop());

  const agentDefinitions = detectAgents();
  const agents = new AgentManager({
    dir: options.dir,
    agents: agentDefinitions,
    restored: store.sessions(),
    mcpServers: (sessionId) => [boardMcp.serverFor(sessionId)],
    onMeta: (meta) => {
      store.appendMeta(meta);
      broadcast({ t: "agent-meta", meta });
    },
    onEvent: (sessionId, event) => {
      store.appendEvent(sessionId, event);
      broadcast({ t: "agent-event", sessionId, event });
    },
    // Live state of the agent, not persisted: the meta keeps the values.
    onOptions: (sessionId, options) => broadcast({ t: "agent-options", sessionId, options }),
    onError: (message) => broadcast({ t: "error", message }),
  });
  process.on("exit", () => agents.close());
  const terminals = new Terminals(
    options.dir,
    (id, data) => broadcast({ t: "term-data", id, data }),
    (id, code) => broadcast({ t: "term-exit", id, code }),
  );

  const handle = (ws: ServerWebSocket<unknown>, message: ClientToServer) => {
    switch (message.t) {
      case "board-save":
        return store.saveBoard(Buffer.from(message.state, "base64"));
      case "agent-create":
        return agents.create(message.id, message.agent);
      case "agent-prompt":
        return agents.prompt(message.sessionId, message.text, message.author);
      case "agent-cancel":
        return agents.cancel(message.sessionId);
      case "agent-config":
        return void agents
          .configure(message.sessionId, message.configId, message.value)
          .catch((error: unknown) => sendError(ws, error));
      case "agent-permission":
        return agents.resolvePermission(
          message.sessionId,
          message.requestId,
          message.optionId,
          message.by,
        );
      case "file-open":
        return files.open(message.path, ws);
      case "file-close":
        return files.close(message.path, ws);
      case "tree-watch":
        return files.watchTree();
      case "term-open": {
        const scrollback = terminals.open(message.id, message.cols, message.rows);
        if (scrollback)
          ws.send(
            JSON.stringify({
              t: "term-data",
              id: message.id,
              data: scrollback,
            } satisfies ServerToClient),
          );
        return;
      }
      case "term-input":
        return terminals.input(message.id, message.data);
      case "term-resize":
        return terminals.resize(message.id, message.cols, message.rows);
      case "board-result":
        return boardMcp.result(message.callId, message.ok, message.text);
    }
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    ...(options.tls && {
      tls: { cert: Bun.file(options.tls.cert), key: Bun.file(options.tls.key) },
    }),
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws")
        return new Response("canvas server — open the link printed in your terminal", {
          status: 404,
        });
      // A WebSocket is not subject to CORS: any page could open one to
      // localhost. The token is what keeps other sites out.
      if (url.searchParams.get("token") !== room.token)
        return new Response("bad token", { status: 401 });
      return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        clients.add(ws);
        const board = store.board();
        const { token: _, ...secrets } = room;
        ws.send(
          JSON.stringify({
            t: "welcome",
            room: secrets,
            cwd: options.dir,
            agents: agentDefinitions.map(({ kind, label }) => ({ kind, label })),
            board: board ? Buffer.from(board).toString("base64") : null,
            sessions: agents.snapshots(),
          } satisfies ServerToClient),
        );
      },
      message(ws, data) {
        try {
          handle(ws, JSON.parse(String(data)) as ClientToServer);
        } catch (error) {
          sendError(ws, error);
        }
      },
      close(ws) {
        clients.delete(ws);
        files.drop(ws);
      },
    },
  });

  return { server, room };
}

function sendError(ws: ServerWebSocket<unknown>, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  ws.send(JSON.stringify({ t: "error", message } satisfies ServerToClient));
}

/**
 * Keep canvas's own files out of the user's commits: `.canvas/` holds board
 * and session state. `.git/info/exclude` is local to the clone and never
 * committed itself.
 */
function excludeFromGit(dir: string) {
  const exclude = join(dir, ".git", "info", "exclude");
  if (!existsSync(join(dir, ".git", "info"))) return;
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const missing = [".canvas/"].filter((line) => !current.split("\n").includes(line));
  if (missing.length)
    appendFileSync(exclude, `\n# canvas: local state, never committed\n${missing.join("\n")}\n`);
}
