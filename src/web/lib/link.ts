/**
 * Everything a browser needs to join a board rides in its URL:
 *
 *   /?room=<id>#k=<trystero key>&pk=<host public key>[&server=<ws url>&token=<t>]
 *     [&relay=<wss url>&via=transport|signal&rt=<relay token>]
 *
 * `server` + `token` make you the host (only the CLI prints them); without
 * them you are a guest. `relay` names the board's `canvas relay` (ADR 0008),
 * how to use it and, `rt`, the guest token it takes; the host gets its own
 * from `canvas serve`. Secrets are in the fragment, which never leaves the
 * browser — the web host serving this app does not see them.
 */

import type { RelayVia } from "../../shared/protocol";

export interface RelayLink {
  readonly url: string;
  readonly via: RelayVia;
  readonly token: string;
}

export interface BoardLink {
  readonly roomId: string;
  readonly key: string;
  readonly hostPublicKey: string;
  readonly host: { readonly server: string; readonly token: string } | null;
  readonly relay: RelayLink | null;
}

export function readLink(location: Location = window.location): BoardLink | null {
  const roomId = new URLSearchParams(location.search).get("room");
  const fragment = new URLSearchParams(location.hash.slice(1));
  const key = fragment.get("k");
  const hostPublicKey = fragment.get("pk");
  if (!roomId || !key || !hostPublicKey) return null;
  const server = fragment.get("server");
  const token = fragment.get("token");
  const relay = fragment.get("relay");
  const via = fragment.get("via") === "signal" ? "signal" : "transport";
  const relayToken = fragment.get("rt");
  return {
    roomId,
    key,
    hostPublicKey,
    host: server && token ? { server, token } : null,
    relay: relay && relayToken ? { url: relay, via, token: relayToken } : null,
  };
}

/**
 * `app` is where this app is served from: the origin plus Vite's base, so a
 * guest of the `next` UI (`/next/`) lands on the same build as its host.
 * `relay`: the board's relay with the guest token `canvas serve` signed, if it has one.
 */
export function guestLink(
  link: BoardLink,
  app: string = new URL(import.meta.env.BASE_URL, window.location.origin).href,
  relay: RelayLink | null = null,
): string {
  const fragment = new URLSearchParams({ k: link.key, pk: link.hostPublicKey });
  if (relay) {
    fragment.set("relay", relay.url);
    fragment.set("via", relay.via);
    fragment.set("rt", relay.token);
  }
  return `${app.replace(/\/$/, "")}/?room=${link.roomId}#${fragment}`;
}

// ---------------------------------------------------------------------------

export interface Identity {
  readonly name: string;
  readonly color: string;
}

/** Presence hues: distinct at a glance, readable as a label background with dark text. */
const PRESENCE = [
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#ec4899",
  "#a855f7",
  "#14b8a6",
  "#eab308",
  "#ef4444",
];
const ANIMALS = [
  "Otter",
  "Heron",
  "Lynx",
  "Badger",
  "Falcon",
  "Marten",
  "Ibex",
  "Puffin",
  "Gecko",
  "Walrus",
];

export function loadIdentity(): Identity {
  const stored = localStorage.getItem("canvas.identity");
  if (stored) return JSON.parse(stored) as Identity;
  const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;
  const identity = { name: pick(ANIMALS), color: pick(PRESENCE) };
  saveIdentity(identity);
  return identity;
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem("canvas.identity", JSON.stringify(identity));
}
