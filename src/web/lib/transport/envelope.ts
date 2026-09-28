/**
 * What the relay transport puts on the wire (ADR 0008): every message sealed
 * with AES-GCM under a key derived from the board key, so `canvas relay` sees
 * only ciphertext. One fixed key per board, no forward secrecy: anyone who
 * records the relay's traffic and later holds a guest link can read it.
 *
 * Inside the seal, the sender's id (checked against the one the relay
 * stamps), a random epoch per page load, a counter and the time. A receiver
 * takes each (sender, epoch)'s counter only upwards and nothing older than
 * `MAX_AGE_MS`: a relay can't replay a request to the host to run it again.
 */

import { decodeFrame, encodeFrame } from "../../../shared/relay-protocol";
import { deriveBits } from "../../../shared/relay-room";

export type Kind = "message" | "request" | "reply" | "reply-error";

export interface Envelope {
  readonly channel: string;
  readonly kind: Kind;
  /** Request/reply id. */
  readonly id?: string;
  readonly body: unknown;
}

interface SealedHeader {
  readonly c: string;
  readonly k: "m" | "q" | "r" | "e";
  readonly i?: string;
  /** Sender peer id. */
  readonly s: string;
  readonly e: string;
  readonly n: number;
  /** Date.now() of sending. */
  readonly t: number;
  /** Body is bytes (1) or JSON (0). */
  readonly b: 0 | 1;
}

const KIND = { message: "m", request: "q", reply: "r", "reply-error": "e" } as const;
const KIND_OF = { m: "message", q: "request", r: "reply", e: "reply-error" } as const;
export const MAX_AGE_MS = 120_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function boardCipher(boardKey: string, room: string): Promise<BoardCipher> {
  const bits = await deriveBits(boardKey, "canvas-relay-data");
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  return new BoardCipher(key, encoder.encode(room));
}

export class BoardCipher {
  private readonly epoch = crypto.randomUUID().slice(0, 8);
  private counter = 0;
  /** `${sender}:${epoch}` → the highest counter taken. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly key: CryptoKey,
    /** Additional data: a sealed message only opens in its own room. */
    private readonly room: Uint8Array<ArrayBuffer>,
  ) {}

  async seal(sender: string, envelope: Envelope, now = Date.now()): Promise<Uint8Array> {
    const bytes = envelope.body instanceof Uint8Array;
    const header: SealedHeader = {
      c: envelope.channel,
      k: KIND[envelope.kind],
      ...(envelope.id && { i: envelope.id }),
      s: sender,
      e: this.epoch,
      n: ++this.counter,
      t: now,
      b: bytes ? 1 : 0,
    };
    const body = bytes
      ? (envelope.body as Uint8Array)
      : encoder.encode(JSON.stringify(envelope.body ?? null));
    const plain = encodeFrame(header, body);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.room },
      this.key,
      plain,
    );
    const sealed = new Uint8Array(12 + cipher.byteLength);
    sealed.set(iv);
    sealed.set(new Uint8Array(cipher), 12);
    return sealed;
  }

  /** The envelope, or why it was dropped. `from`: the sender as the relay says. */
  async open(
    from: string,
    received: Uint8Array,
    now = Date.now(),
  ): Promise<{ envelope: Envelope } | { dropped: string }> {
    const sealed = new Uint8Array(received);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData: this.room },
        this.key,
        sealed.subarray(12),
      );
    } catch {
      return { dropped: "doesn't decrypt with this board's key" };
    }
    const frame = decodeFrame<SealedHeader>(new Uint8Array(plain));
    if (!frame) return { dropped: "malformed" };
    const { header, payload } = frame;
    if (header.s !== from) return { dropped: `sealed by ${header.s}, relayed as from ${from}` };
    if (Math.abs(now - header.t) > MAX_AGE_MS) return { dropped: "too old: a replay?" };
    const stream = `${header.s}:${header.e}`;
    if (header.n <= (this.seen.get(stream) ?? 0)) return { dropped: "seen before: a replay" };
    this.seen.set(stream, header.n);
    return {
      envelope: {
        channel: header.c,
        kind: KIND_OF[header.k],
        ...(header.i && { id: header.i }),
        body: header.b ? payload.slice() : JSON.parse(decoder.decode(payload)),
      },
    };
  }
}
