/**
 * Handing a new room over (ADR 0011, decision 6). When the invite link is
 * reset, `canvas serve` mints a new room id and key; the host tells each
 * member where it is, and only members: the new key must not reach anyone
 * holding the old one — a removed member, or a relay forwarding what it
 * shouldn't. On WebRTC each message is already per peer; on the relay
 * transport everything is sealed with the old board key, which removed
 * members still hold. So the move is sealed to the member itself.
 *
 * Each page makes an ECDH P-256 key of its own (the seal key: the browser key
 * is ECDSA, for signing only) and sends its public half with its join proof,
 * signed by its browser key (`shared/identity.ts`). The host seals the move
 * to it: a fresh ECDH key of its own, HKDF, AES-GCM. Inside, the host key's
 * signature over `canvas-move:<old room>:<peer id>:<move>`: anyone can seal
 * to a public key, only the host signs, and only for that peer in that room.
 */

import { fromBase64Url, toBase64Url, verify } from "../../shared/identity";
import { signText } from "./host-key";
import type { RelayLink } from "./link";

/** Where the board went: what a member's link becomes. */
export interface Move {
  readonly roomId: string;
  readonly key: string;
  /** The board's relay with the new room's guest token; null without a relay. */
  readonly relay: RelayLink | null;
}

/** A move sealed to one member's seal key. base64url throughout. */
export interface SealedMove {
  /** The host's one-time ECDH public key. */
  readonly from: string;
  readonly iv: string;
  readonly data: string;
}

/** A page's own ECDH key; its public half is in its join proof. */
export interface SealKey {
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const moveStatement = (oldRoom: string, peerId: string, move: string) =>
  `canvas-move:${oldRoom}:${peerId}:${move}`;

export async function makeSealKey(): Promise<SealKey> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { publicKey: toBase64Url(raw), privateKey: pair.privateKey };
}

/** Host: `move`, for `peerId` alone, leaving `oldRoom`. */
export async function sealMove(
  hostPrivateKey: JsonWebKey,
  oldRoom: string,
  peerId: string,
  sealKey: string,
  move: Move,
): Promise<SealedMove> {
  const text = JSON.stringify(move);
  const signature = await signText(hostPrivateKey, moveStatement(oldRoom, peerId, text));
  const own = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const key = await aesKey(own.privateKey, sealKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify({ move: text, signature })),
  );
  return {
    from: toBase64Url(await crypto.subtle.exportKey("raw", own.publicKey)),
    iv: toBase64Url(iv),
    data: toBase64Url(data),
  };
}

/**
 * Guest: the move the host sealed to us, if it opens with our seal key and
 * the host key signed it for us (`selfId`) in the room we are in; else null.
 */
export async function openMove(
  own: SealKey,
  hostPublicKey: string,
  room: string,
  selfId: string,
  sealed: SealedMove,
): Promise<Move | null> {
  try {
    const key = await aesKey(own.privateKey, sealed.from);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(sealed.iv) },
      key,
      fromBase64Url(sealed.data),
    );
    const { move, signature } = JSON.parse(decoder.decode(plain)) as {
      move: string;
      signature: string;
    };
    if (typeof move !== "string" || typeof signature !== "string") return null;
    if (!(await verify(hostPublicKey, moveStatement(room, selfId, move), signature))) return null;
    return parseMove(move);
  } catch {
    return null;
  }
}

async function aesKey(privateKey: CryptoKey, publicKey: string): Promise<CryptoKey> {
  const theirs = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("canvas-move") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseMove(text: string): Move | null {
  const move = JSON.parse(text) as Move;
  if (typeof move?.roomId !== "string" || typeof move.key !== "string") return null;
  const relay = move.relay;
  if (relay !== null) {
    if (typeof relay?.url !== "string" || typeof relay.token !== "string") return null;
    if (relay.via !== "transport" && relay.via !== "signal") return null;
  }
  return { roomId: move.roomId, key: move.key, relay };
}
