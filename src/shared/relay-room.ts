/**
 * What peers of a board derive from its key for a `canvas relay` (ADR 0008):
 * the relay room, and the key that seals messages over the relay transport.
 *
 * The relay room comes from the board key `k`, not its `?room=` id: the web
 * host sees that id, and the relay shouldn't be able to match its rooms to
 * board URLs — nor anyone guess a room without the key.
 *
 * WebCrypto only: `canvas serve` and the browser both use it.
 */

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Key material from a board key: HKDF-SHA256 with a purpose label. */
export async function deriveBits(
  boardKey: string,
  info: string,
  bits = 256,
): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(boardKey), "HKDF", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(info) },
    base,
    bits,
  );
  return new Uint8Array(derived);
}

/** The relay room of a board: the same for everyone holding its key, meaningless without it. */
export async function relayRoom(boardKey: string): Promise<string> {
  return b64url(await deriveBits(boardKey, "canvas-relay-room", 128));
}
