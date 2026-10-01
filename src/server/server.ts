/**
 * `canvas serve`: the local half of canvas. One WebSocket endpoint that only
 * the host's browser may use, in one tab at a time: a newer tab takes over
 * from an older one. Each socket first answers a challenge with a paired
 * browser's key, or pairs it with a code (`owners.ts`); until then it gets
 * nothing else. Nothing here knows about guests — the host's browser is the relay.
 */

import type { ServerWebSocket } from "bun";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nonce } from "../shared/identity";
import {
  AUTH_REFUSED,
  HOST_REPLACED,
  type ClientToServer,
  type RelayVia,
  type ServerToClient,
  type WelcomeRelay,
} from "../shared/protocol";
import { relayRoom } from "../shared/relay-room";
import { AgentManager, detectAgents } from "./agents";
import { BoardMcp } from "./board-mcp";
import { Files } from "./files";
import { Owners } from "./owners";
import { Scratch } from "./scratch";
import { canvasSkills } from "./skills";
import { Store } from "./store";
import { signRelayToken, type Issuer } from "./relay-token";
import { Terminals } from "./terminals";

export interface ServeOptions {
  readonly dir: string;
  readonly port: number;
  readonly hostname: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  /** The published version this runs as; none for a checkout. */
  readonly version?: string;
  /** Guests reach the board through this `canvas relay` (ADR 0008). */
  readonly relay?: ServeRelay;
  /** Print a fresh pairing code even if a browser is paired already. */
  readonly pair?: boolean;
}

/** A socket's state: the nonce it must sign, then whether it did. */
interface Conn {
  readonly nonce: string;
  state: "challenged" | "checking" | "owner";
  timer?: ReturnType<typeof setTimeout>;
}

/** How long a socket has to answer its challenge. */
const AUTH_MS = 15_000;

export interface ServeRelay {
  readonly url: string;
  readonly via: RelayVia;
  /** The issuer key the relay's operator gave this host. */
  readonly issuer: Issuer;
}

export async function serve(options: ServeOptions) {
  const store = new Store(options.dir);
  excludeFromGit(options.dir);
  const room = await store.room();
  const owners = new Owners(store.root);
  // A new code at every start while nobody is paired, and on request.
  const pairing = options.pair || owners.list().length === 0 ? owners.pair() : null;
  const relayRoomName = options.relay ? await relayRoom(room.key) : null;
  // Signed for every host tab that connects: its token and the one its guest
  // links carry are good for 30 days from then.
  const relaySetup = (): WelcomeRelay | null =>
    options.relay && relayRoomName
      ? {
          url: options.relay.url,
          via: options.relay.via,
          hostToken: signRelayToken(options.relay.issuer, relayRoomName, "host"),
          guestToken: signRelayToken(options.relay.issuer, relayRoomName, "guest"),
        }
      : null;
  // The host tab: the board, and so every board tool call, lives there.
  let host: ServerWebSocket<Conn> | null = null;
  const broadcast = (message: ServerToClient) => host?.send(JSON.stringify(message));

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
    scratch,
    relay: (call) => {
      if (!host) return false;
      host.send(JSON.stringify({ t: "board-call", ...call } satisfies ServerToClient));
      return true;
    },
    skills: canvasSkills(),
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

  const welcome = (ws: ServerWebSocket<Conn>) => {
    if (host) {
      files.drop(host);
      host.close(HOST_REPLACED, "opened in another tab");
    }
    host = ws;
    const board = store.board();
    ws.send(
      JSON.stringify({
        t: "welcome",
        version: options.version ?? null,
        room,
        cwd: options.dir,
        agents: agentDefinitions.map(({ kind, label }) => ({ kind, label })),
        board: board ? Buffer.from(board).toString("base64") : null,
        sessions: agents.snapshots(),
        relay: relaySetup(),
      } satisfies ServerToClient),
    );
  };

  /** A socket's first message: its answer to the challenge, and nothing else. */
  const authenticate = async (ws: ServerWebSocket<Conn>, message: ClientToServer) => {
    if (message.t !== "auth" || ws.data.state !== "challenged")
      return ws.close(AUTH_REFUSED, "authenticate first");
    ws.data.state = "checking";
    const result = await owners.authenticate(room.roomId, ws.data.nonce, message);
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!result.ok) return ws.close(AUTH_REFUSED, result.reason);
    clearTimeout(ws.data.timer);
    ws.data.state = "owner";
    if (result.paired) console.log(`  paired a browser: ${result.owner.fingerprint}`);
    welcome(ws);
  };

  const handle = (ws: ServerWebSocket<Conn>, message: ClientToServer) => {
    switch (message.t) {
      case "auth":
        return;
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
        return boardMcp.result(message.callId, message.ok, message.text, message.images);
    }
  };

  const server = Bun.serve<Conn>({
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
      // localhost. The challenge is what keeps other sites out.
      const data: Conn = { nonce: nonce(), state: "challenged" };
      return server.upgrade(req, { data })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        ws.data.timer = setTimeout(() => ws.close(AUTH_REFUSED, "no answer"), AUTH_MS);
        ws.send(JSON.stringify({ t: "challenge", nonce: ws.data.nonce } satisfies ServerToClient));
      },
      message(ws, data) {
        if (ws.data.state !== "owner") {
          let message: ClientToServer;
          try {
            message = JSON.parse(String(data)) as ClientToServer;
          } catch {
            return ws.close(AUTH_REFUSED, "authenticate first");
          }
          return void authenticate(ws, message);
        }
        // Still in flight from a tab that was just replaced.
        if (ws !== host) return;
        try {
          handle(ws, JSON.parse(String(data)) as ClientToServer);
        } catch (error) {
          sendError(ws, error);
        }
      },
      close(ws) {
        clearTimeout(ws.data.timer);
        if (ws === host) host = null;
        files.drop(ws);
      },
    },
  });

  return { server, room, pairing };
}

function sendError(ws: ServerWebSocket<Conn>, error: unknown) {
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
