/**
 * Everyone in a room holds the room key, so knowing it proves nothing about
 * who is the host. The CLI mints an ECDSA keypair per board: the public half
 * rides in every link, the private half only reaches the host's browser
 * (over the WebSocket only a paired browser gets). The host signs its peer id; guests only
 * take board state, agent output and room policy from the peer that verifies. It signs the
 * member list too (`member-list.ts`).
 */

import {
  KEY_ALGORITHM as ALGORITHM,
  SIGNATURE,
  fromBase64Url,
  toBase64Url,
} from "../../shared/identity";

const statement = (roomId: string, peerId: string) =>
  new TextEncoder().encode(`canvas-host:${roomId}:${peerId}`);

export const signHost = (privateKey: JsonWebKey, roomId: string, peerId: string) =>
  sign(privateKey, statement(roomId, peerId));

/** Sign `text` with the host key; base64url. Statements are domain-separated by their prefix. */
export const signText = (privateKey: JsonWebKey, text: string) =>
  sign(privateKey, new TextEncoder().encode(text));

async function sign(privateKey: JsonWebKey, data: BufferSource): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey, ALGORITHM, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign(SIGNATURE, key, data));
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
