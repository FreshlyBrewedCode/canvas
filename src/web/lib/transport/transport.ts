/**
 * How a board's peers reach each other (ADR 0008). `room.ts` sees only this:
 * named channels to one peer or everyone, request/reply to one peer, peers
 * joining and leaving. Three adapters, picked by the link:
 *
 *   p2p           trystero: Nostr relays to meet, WebRTC to talk (today's)
 *   relay-signal  trystero: `canvas relay` to meet, WebRTC to talk
 *   relay         everything through `canvas relay`, end-to-end encrypted
 *
 * The shape follows trystero's actions, so its adapter is a thin wrapper.
 */

import type { RelayInfo } from "../connection";

export type TransportKind = "p2p" | "relay-signal" | "relay";

/** Anything JSON, or bytes. */
export type Payload = unknown;

export interface MessageContext {
  readonly peerId: string;
}

export interface SendOptions {
  /** One peer or several; absent: everyone. */
  readonly target?: string | ReadonlyArray<string>;
}

export interface Channel<T extends Payload = Payload> {
  send(data: T, options?: SendOptions): Promise<void>;
  onMessage: ((data: T, context: MessageContext) => void | Promise<void>) | null;
}

export interface RequestChannel<T extends Payload = Payload, R extends Payload = Payload> {
  request(data: T, options: { readonly target: string; readonly timeoutMs?: number }): Promise<R>;
  onRequest: ((data: T, context: MessageContext) => R | Promise<R>) | null;
}

/** What the connection dialog shows about a transport. */
export interface TransportDiagnostics {
  /** Signalling relays (p2p, relay-signal) or the relay carrying everything (relay). */
  readonly relays: ReadonlyArray<RelayInfo>;
  /** WebRTC connections by peer id; empty for the relay transport. */
  readonly connections: Readonly<Record<string, RTCPeerConnection>>;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly selfId: string;
  /** Peers we can send to now. */
  peers(): string[];
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  channel<T extends Payload>(name: string): Channel<T>;
  requests<T extends Payload, R extends Payload>(name: string): RequestChannel<T, R>;
  leave(): void;
  diagnostics(): TransportDiagnostics;
}

/** What goes wrong, for the connection log: a peer we couldn't reach, the relay refusing us. */
export type TransportError = (error: string, peerId?: string) => void;
