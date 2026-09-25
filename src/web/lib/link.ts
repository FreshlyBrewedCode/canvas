/**
 * Everything a browser needs to join a board rides in its URL:
 *
 *   /?room=<id>#k=<trystero key>&pk=<host public key>[&server=<ws url>&token=<t>]
 *
 * `server` + `token` make you the host (only the CLI prints them); without
 * them you are a guest. Secrets are in the fragment, which never leaves the
 * browser — the web host serving this app does not see them.
 */

export interface BoardLink {
  readonly roomId: string;
  readonly key: string;
  readonly hostPublicKey: string;
  readonly host: { readonly server: string; readonly token: string } | null;
}

export function readLink(location: Location = window.location): BoardLink | null {
  const roomId = new URLSearchParams(location.search).get("room");
  const fragment = new URLSearchParams(location.hash.slice(1));
  const key = fragment.get("k");
  const hostPublicKey = fragment.get("pk");
  if (!roomId || !key || !hostPublicKey) return null;
  const server = fragment.get("server");
  const token = fragment.get("token");
  return { roomId, key, hostPublicKey, host: server && token ? { server, token } : null };
}

export function guestLink(link: BoardLink, origin: string = window.location.origin): string {
  const fragment = new URLSearchParams({ k: link.key, pk: link.hostPublicKey });
  return `${origin}/?room=${link.roomId}#${fragment}`;
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
