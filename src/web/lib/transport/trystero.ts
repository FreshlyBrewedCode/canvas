/**
 * The trystero adapters: peers meet through Nostr relays (`p2p`) or a
 * `canvas relay`'s `/signal` (`relay-signal`), then talk over WebRTC.
 */

import { joinRoom as joinWsRelay, getRelaySockets as wsRelaySockets } from "@trystero-p2p/ws-relay";
import { getRelaySockets as nostrSockets, joinRoom as joinNostr, selfId } from "trystero";

import { relayState } from "../connection";
import type { Transport, TransportError } from "./transport";

export interface TrysteroOptions {
  readonly appId: string;
  /** The board key: encrypts signalling. */
  readonly password: string;
  readonly roomId: string;
  /** `relay-signal`: the relay's `/signal` URL, with its token. */
  readonly signalUrl?: string;
}

export function trysteroTransport(options: TrysteroOptions, onError: TransportError): Transport {
  const config = { appId: options.appId, password: options.password };
  const callbacks = {
    onJoinError: ({ error, peerId }: { error: string; peerId: string }) => onError(error, peerId),
  };
  const room = options.signalUrl
    ? joinWsRelay(
        { ...config, relayConfig: { urls: [options.signalUrl] } },
        options.roomId,
        callbacks,
      )
    : joinNostr(config, options.roomId, callbacks);
  const sockets = options.signalUrl ? wsRelaySockets : nostrSockets;

  return {
    kind: options.signalUrl ? "relay-signal" : "p2p",
    selfId,
    peers: () => Object.keys(room.getPeers()),
    get onPeerJoin() {
      return room.onPeerJoin;
    },
    set onPeerJoin(handler) {
      room.onPeerJoin = handler;
    },
    get onPeerLeave() {
      return room.onPeerLeave;
    },
    set onPeerLeave(handler) {
      room.onPeerLeave = handler;
    },
    channel: (name) => room.makeAction(name) as never,
    requests: (name) => room.makeAction(name, { kind: "request" }) as never,
    leave: () => void room.leave(),
    diagnostics: () => ({
      relays: Object.entries(sockets() as Record<string, WebSocket>).map(([url, socket]) => ({
        // The token rides in the signal URL: keep it out of the dialog and reports.
        url: url.replace(/\?.*$/, ""),
        state: relayState(socket.readyState),
      })),
      connections: room.getPeers(),
    }),
  };
}
