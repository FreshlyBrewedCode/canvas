/**
 * `canvas relay` (ADR 0008): for networks where peers can't reach the public
 * Nostr relays, or each other over WebRTC. It stores nothing and reads
 * nothing; it forwards what peers send, to peers holding a token signed with
 * one of its issuer keys (`relay-token.ts`).
 *
 *   /transport  everything, end-to-end encrypted by the peers
 *               (`shared/relay-protocol.ts`); the token comes in the join
 *   /signal     trystero's ws-relay protocol: peers find each other here,
 *               then connect over WebRTC. `?t=<token>`, as the trystero
 *               client can't send one otherwise
 *   /health     counts, for monitoring: no rooms, no issuers
 *
 * One relay serves any number of boards and hosts: rooms appear on first
 * join and go with the last peer. Limits (`relay-config.ts`) keep one board or
 * issuer from starving the rest.
 */

import type { Server, ServerWebSocket } from "bun";

import {
  decodeFrame,
  encodeFrame,
  RELAY_HOST_REPLACED,
  RELAY_RATE_LIMITED,
  RELAY_REFUSED,
  type RelayClientControl,
  type RelayServerControl,
} from "../shared/relay-protocol";
import { DEFAULT_LIMITS, type RelayLimits } from "./relay-config";
import { verifyRelayToken, type RelayRole } from "./relay-token";

export interface RelayOptions {
  readonly port: number;
  readonly hostname: string;
  /** Issuer name → secret. */
  readonly issuers: ReadonlyMap<string, string>;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly limits?: Partial<RelayLimits>;
  /** How long a `/transport` connection may take to join. */
  readonly joinTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

type Socket = ServerWebSocket<SocketData>;
interface Common {
  /** Set once admitted: counts against the issuer's connections. */
  issuer: string | null;
  readonly budget: Budget;
}
type SocketData =
  | (Common & { readonly path: "signal"; readonly claimed: string })
  | (Common & {
      readonly path: "transport";
      room: string | null;
      peer: string | null;
      role: RelayRole | null;
      timer: ReturnType<typeof setTimeout> | null;
    });
type TransportSocket = Socket & { data: { path: "transport" } };

const PEER_ID = /^[\w-]{1,64}$/;
/** Signalling carries offers, not data: small messages only. */
const MAX_SIGNAL_MESSAGE = 64 * 1024;

export function startRelay(options: RelayOptions): Server<SocketData> {
  const { issuers, log = () => {} } = options;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  /** room → peer id → socket */
  const rooms = new Map<string, Map<string, Socket>>();
  const perIssuer = new Map<string, number>();

  const control = (ws: Socket, message: RelayServerControl) => ws.send(JSON.stringify(message));
  const refuse = (ws: Socket, message: string) => {
    control(ws, { t: "error", message });
    ws.close(RELAY_REFUSED, message.slice(0, 120));
  };

  /** Count a connection against its issuer, if the issuer has room for it. */
  function admit(ws: Socket, issuer: string): boolean {
    const open = perIssuer.get(issuer) ?? 0;
    if (open >= limits.connectionsPerIssuer) return false;
    perIssuer.set(issuer, open + 1);
    ws.data.issuer = issuer;
    return true;
  }

  function release(ws: Socket) {
    const { issuer } = ws.data;
    if (!issuer) return;
    const open = (perIssuer.get(issuer) ?? 1) - 1;
    if (open > 0) perIssuer.set(issuer, open);
    else perIssuer.delete(issuer);
    ws.data.issuer = null;
  }

  /** Within the connection's budget, or it's closed; the peer reconnects later. */
  function spend(ws: Socket, bytes: number): boolean {
    if (ws.data.budget.spend(bytes)) return true;
    control(ws, { t: "error", message: "rate limited: too many messages or bytes" });
    ws.close(RELAY_RATE_LIMITED, "rate limited");
    return false;
  }

  function join(ws: TransportSocket, message: RelayClientControl) {
    if (ws.data.room) return refuse(ws, "already joined");
    if (typeof message.peer !== "string" || !PEER_ID.test(message.peer))
      return refuse(ws, "bad peer id");
    const check = verifyRelayToken(String(message.token), issuers);
    if (!check.ok) return refuse(ws, `token refused: ${check.reason}`);
    if (check.token.room !== message.room) return refuse(ws, "token refused: for another room");
    const room = rooms.get(message.room) ?? new Map<string, Socket>();
    if (room.has(message.peer)) return refuse(ws, "peer id in use");
    if (room.size >= limits.peersPerRoom) return refuse(ws, "room full");
    if (!admit(ws, check.token.issuer))
      return refuse(ws, `issuer ${check.token.issuer} is at its connection limit`);
    // One host per room: a newer host tab takes over, as with `canvas serve`.
    if (check.token.role === "host")
      for (const other of room.values())
        if (other.data.path === "transport" && other.data.role === "host")
          other.close(RELAY_HOST_REPLACED, "another host tab joined");

    if (ws.data.timer) clearTimeout(ws.data.timer);
    rooms.set(message.room, room);
    const peers = [...room.keys()];
    room.set(message.peer, ws);
    Object.assign(ws.data, { room: message.room, peer: message.peer, role: check.token.role });
    control(ws, { t: "joined", peers });
    for (const other of room.values())
      if (other !== ws) control(other, { t: "peer-join", peer: message.peer });
    log(
      `join ${check.token.issuer}/${check.token.role} (${room.size} in room, ${rooms.size} rooms)`,
    );
  }

  function leave(ws: TransportSocket) {
    if (ws.data.timer) clearTimeout(ws.data.timer);
    const { room: name, peer } = ws.data;
    if (!name || !peer) return;
    const room = rooms.get(name);
    if (room?.get(peer) !== ws) return;
    room.delete(peer);
    if (room.size === 0) rooms.delete(name);
    else for (const other of room.values()) control(other, { t: "peer-leave", peer });
  }

  function forward(ws: TransportSocket, frame: Uint8Array) {
    const room = ws.data.room ? rooms.get(ws.data.room) : undefined;
    if (!room || !ws.data.peer) return;
    const decoded = decodeFrame<{ to?: unknown }>(frame);
    if (!decoded) return;
    const out = encodeFrame({ from: ws.data.peer }, decoded.payload);
    const to = decoded.header.to;
    const targets = Array.isArray(to)
      ? to.flatMap((id) => {
          const target = room.get(String(id));
          return target && target !== ws ? [target] : [];
        })
      : [...room.values()].filter((s) => s !== ws);
    for (const target of targets) target.send(out);
  }

  /** trystero's ws-relay protocol, on Bun's pub/sub (finding 15). */
  function signal(ws: Socket, raw: string | Buffer) {
    if (raw.length > MAX_SIGNAL_MESSAGE) return;
    let message: { type?: string; topic?: unknown; payload?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.topic !== "string") return;
    const topic = `signal:${message.topic}`;
    if (message.type === "subscribe") ws.subscribe(topic);
    else if (message.type === "unsubscribe") ws.unsubscribe(topic);
    else if (message.type === "publish")
      ws.publish(topic, JSON.stringify({ topic: message.topic, payload: message.payload }));
  }

  const budget = () => new Budget(limits.messagesPerSecond, limits.bytesPerSecond);

  return Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname,
    ...(options.tls && {
      tls: { cert: Bun.file(options.tls.cert), key: Bun.file(options.tls.key) },
    }),
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/transport") {
        const data: SocketData = {
          path: "transport",
          issuer: null,
          budget: budget(),
          room: null,
          peer: null,
          role: null,
          timer: null,
        };
        if (server.upgrade(req, { data })) return;
        return new Response("a WebSocket endpoint\n", { status: 426 });
      }
      if (url.pathname === "/signal") {
        const check = verifyRelayToken(url.searchParams.get("t") ?? "", issuers);
        if (!check.ok) return new Response(`token refused: ${check.reason}\n`, { status: 401 });
        const data: SocketData = {
          path: "signal",
          claimed: check.token.issuer,
          issuer: null,
          budget: budget(),
        };
        if (server.upgrade(req, { data })) return;
        return new Response("a WebSocket endpoint\n", { status: 426 });
      }
      if (url.pathname === "/health") {
        let peers = 0;
        for (const room of rooms.values()) peers += room.size;
        const connections = [...perIssuer.values()].reduce((sum, n) => sum + n, 0);
        return Response.json({ ok: true, rooms: rooms.size, peers, connections });
      }
      if (url.pathname === "/") return new Response("canvas relay\n");
      return new Response("not found\n", { status: 404 });
    },
    websocket: {
      maxPayloadLength: limits.maxMessage,
      open(ws) {
        if (ws.data.path === "signal") {
          if (!admit(ws, ws.data.claimed)) refuse(ws, "issuer at its connection limit");
          return;
        }
        // A `/transport` connection counts once its join is admitted; until
        // then it only gets a few seconds.
        const transport = ws as TransportSocket;
        transport.data.timer = setTimeout(() => {
          if (!transport.data.room) refuse(transport, "no join in time");
        }, options.joinTimeoutMs ?? 10_000);
      },
      message(ws, raw) {
        if (!spend(ws, raw.length)) return;
        if (ws.data.path === "signal") return signal(ws, raw);
        const transport = ws as TransportSocket;
        if (typeof raw !== "string") return forward(transport, new Uint8Array(raw));
        let message: RelayClientControl;
        try {
          message = JSON.parse(raw) as RelayClientControl;
        } catch {
          return refuse(ws, "bad message");
        }
        if (message.t === "join") join(transport, message);
      },
      close(ws) {
        if (ws.data.path === "transport") leave(ws as TransportSocket);
        release(ws);
      },
    },
  });
}

/** Two token buckets: messages and bytes per second, bursts up to four seconds' worth. */
export class Budget {
  private messages: number;
  private bytes: number;
  /** When it was last spent from; refilling starts at the first spend. */
  private last: number | null = null;

  constructor(
    private readonly messagesPerSecond: number,
    private readonly bytesPerSecond: number,
    private readonly burstSeconds = 4,
  ) {
    this.messages = messagesPerSecond * burstSeconds;
    this.bytes = bytesPerSecond * burstSeconds;
  }

  spend(bytes: number, now = performance.now()): boolean {
    const seconds = this.last === null ? 0 : Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.messages = Math.min(
      this.messagesPerSecond * this.burstSeconds,
      this.messages + seconds * this.messagesPerSecond,
    );
    this.bytes = Math.min(
      this.bytesPerSecond * this.burstSeconds,
      this.bytes + seconds * this.bytesPerSecond,
    );
    // One message may be larger than the burst (a whole thread): let it through
    // on a full bucket, and go into debt for it.
    if (
      this.messages < 1 ||
      (this.bytes < bytes && this.bytes < this.bytesPerSecond * this.burstSeconds)
    )
      return false;
    this.messages -= 1;
    this.bytes -= bytes;
    return true;
  }
}
