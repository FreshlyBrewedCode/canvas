/**
 * The relay transport (ADR 0008): every message through `canvas relay`'s
 * `/transport`, sealed with the board key (`envelope.ts`). For networks where
 * WebRTC can't connect — VPNs, TLS-inspecting proxies: it's one `wss://` to
 * one server, like any web app.
 *
 * The relay says who is in the room; a peer is reachable while both sockets
 * are open. Reconnects (partysocket) join again, and peers come back as new
 * joins, as they would with trystero.
 */

import ReconnectingWebSocket from "partysocket/ws";

import {
  decodeFrame,
  encodeFrame,
  RELAY_HOST_REPLACED,
  RELAY_REFUSED,
  type RelayClientControl,
  type RelayServerControl,
} from "../../../shared/relay-protocol";
import { relayRoom } from "../../../shared/relay-room";
import { relayState } from "../connection";
import { boardCipher, type BoardCipher, type Envelope } from "./envelope";
import type {
  Channel,
  MessageContext,
  Payload,
  RequestChannel,
  Transport,
  TransportError,
} from "./transport";

export interface RelayTransportOptions {
  /** The relay's base URL: `wss://relay.example`. */
  readonly url: string;
  readonly token: string;
  readonly boardKey: string;
  readonly selfId: string;
  /** `WebSocket` to use: Bun's in tests. */
  readonly WebSocket?: typeof WebSocket;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function relayTransport(options: RelayTransportOptions, onError: TransportError): Transport {
  const channels = new Map<string, Channel & RequestChannel>();
  const pending = new Map<string, Pending>();
  const peers = new Set<string>();
  let cipher: BoardCipher | null = null;
  let room = "";
  let socket: ReconnectingWebSocket | null = null;
  let left = false;
  // Sealing and opening are async; messages must still leave and arrive in
  // order — terminal output, agent events — and the replay counters depend on
  // it. One queue each way.
  let sending: Promise<unknown> = Promise.resolve();
  let receiving: Promise<unknown> = Promise.resolve();

  const transport: Transport = {
    kind: "relay",
    selfId: options.selfId,
    peers: () => [...peers],
    onPeerJoin: null,
    onPeerLeave: null,
    channel: (name) => channel(name) as never,
    requests: (name) => channel(name) as never,
    leave() {
      left = true;
      socket?.close();
      dropPeers();
    },
    diagnostics: () => ({
      relays: socket ? [{ url: options.url, state: relayState(socket.readyState) }] : [],
      connections: {},
    }),
  };

  function channel(name: string): Channel & RequestChannel {
    let existing = channels.get(name);
    if (existing) return existing;
    existing = {
      onMessage: null,
      onRequest: null,
      send: (data: Payload, { target } = {}) =>
        post({ channel: name, kind: "message", body: data }, target),
      request: (data: Payload, { target, timeoutMs = 30_000 }) =>
        new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`no reply from ${target} within ${timeoutMs} ms`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          post({ channel: name, kind: "request", id, body: data }, target).catch((error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }),
    };
    channels.set(name, existing);
    return existing;
  }

  /** Sends while the socket is down are dropped, as with a peer that left. */
  function post(envelope: Envelope, target?: string | ReadonlyArray<string>): Promise<void> {
    const to =
      target === undefined ? undefined : typeof target === "string" ? [target] : [...target];
    const sent = sending.then(async () => {
      if (!cipher || socket?.readyState !== WebSocket.OPEN || to?.length === 0) return;
      const sealed = await cipher.seal(options.selfId, envelope);
      socket.send(encodeFrame(to ? { to } : {}, sealed));
    });
    sending = sent.catch(() => {});
    return sent;
  }

  async function open(frame: Uint8Array) {
    const decoded = decodeFrame<{ from: string }>(frame);
    if (!decoded || !cipher) return null;
    const { from } = decoded.header;
    const opened = await cipher.open(from, decoded.payload);
    if ("dropped" in opened) {
      onError(`dropped a message: ${opened.dropped}`, from);
      return null;
    }
    return { from, envelope: opened.envelope };
  }

  async function dispatch(from: string, envelope: Envelope) {
    const context: MessageContext = { peerId: from };
    switch (envelope.kind) {
      case "message":
        return channels.get(envelope.channel)?.onMessage?.(envelope.body, context);
      case "request": {
        const handler = channels.get(envelope.channel)?.onRequest;
        const reply = (kind: "reply" | "reply-error", body: unknown) =>
          post({ channel: envelope.channel, kind, id: envelope.id!, body }, from);
        if (!handler) return reply("reply-error", `nothing answers ${envelope.channel}`);
        try {
          return await reply("reply", await handler(envelope.body, context));
        } catch (error) {
          return reply("reply-error", error instanceof Error ? error.message : String(error));
        }
      }
      case "reply":
      case "reply-error": {
        const waiter = envelope.id ? pending.get(envelope.id) : undefined;
        if (!waiter) return;
        clearTimeout(waiter.timer);
        pending.delete(envelope.id!);
        if (envelope.kind === "reply") waiter.resolve(envelope.body);
        else waiter.reject(new Error(String(envelope.body)));
      }
    }
  }

  function control(message: RelayServerControl) {
    switch (message.t) {
      case "joined":
        for (const peer of message.peers) addPeer(peer);
        return;
      case "peer-join":
        return addPeer(message.peer);
      case "peer-leave":
        if (peers.delete(message.peer)) transport.onPeerLeave?.(message.peer);
        return;
      case "error":
        return onError(`relay: ${message.message}`);
    }
  }

  function addPeer(peer: string) {
    if (peers.has(peer)) return;
    peers.add(peer);
    transport.onPeerJoin?.(peer);
  }

  function dropPeers() {
    for (const peer of [...peers]) {
      peers.delete(peer);
      transport.onPeerLeave?.(peer);
    }
  }

  void (async () => {
    room = await relayRoom(options.boardKey);
    cipher = await boardCipher(options.boardKey, room);
    if (left) return;
    const ws = new ReconnectingWebSocket(`${options.url.replace(/\/$/, "")}/transport`, [], {
      // Nothing queues while down: the join has to go first, and stale board
      // messages are resent as state anyway.
      maxEnqueuedMessages: 0,
      ...(options.WebSocket && { WebSocket: options.WebSocket }),
    });
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      const join: RelayClientControl = {
        t: "join",
        room,
        peer: options.selfId,
        token: options.token,
      };
      ws.send(JSON.stringify(join));
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") control(JSON.parse(event.data) as RelayServerControl);
      else {
        // Opened in arrival order; handled without waiting for each other (a
        // request can wait minutes for the host to approve it).
        const frame = new Uint8Array(event.data as ArrayBuffer);
        const opened = receiving.then(() => open(frame));
        receiving = opened.catch(() => {});
        void opened
          .then((message) => message && dispatch(message.from, message.envelope))
          .catch((error) => onError(`relay transport: ${String(error)}`));
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      dropPeers();
      if (event.code === RELAY_REFUSED || event.code === RELAY_HOST_REPLACED) {
        // Retrying can't help: a bad token, or another host tab has the room.
        ws.close();
        onError(`relay closed the connection: ${event.reason || event.code}`);
      }
    });
  })().catch((error) => onError(`relay transport: ${String(error)}`));

  return transport;
}
