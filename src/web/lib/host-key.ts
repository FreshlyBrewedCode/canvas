/**
 * Everyone in a room holds the room key, so knowing it proves nothing about
 * who is the host. The CLI mints an ECDSA keypair per board: the public half
 * rides in every link, the private half only reaches the host's browser
 * (over the token-guarded WebSocket). The host signs its peer id; guests only
 * take board state, agent output and room policy from the peer that verifies.
 */

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNATURE = { name: "ECDSA", hash: "SHA-256" } as const;

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const statement = (roomId: string, peerId: string) =>
  new TextEncoder().encode(`canvas-host:${roomId}:${peerId}`);

export async function signHost(
  privateKey: JsonWebKey,
  roomId: string,
  peerId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey, ALGORITHM, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign(SIGNATURE, key, statement(roomId, peerId)));
}

export async function verifyHost(
  publicKey: string,
  roomId: string,
  peerId: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), ALGORITHM, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      SIGNATURE,
      key,
      fromBase64Url(signature),
      statement(roomId, peerId),
    );
  } catch {
    return false;
  }
}
