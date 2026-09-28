/**
 * The wire of `canvas relay`'s `/transport` (ADR 0008). The relay forwards
 * opaque bytes between the peers of a room and knows nothing else: payloads
 * are end-to-end encrypted by the peers (`web/lib/transport/relay.ts`).
 *
 * Control messages are JSON text frames. Data is a binary frame:
 *
 *   [u32 header length][header, JSON][payload]
 *
 * peer → relay header: `{to?: string[]}` (absent: everyone else in the room)
 * relay → peer header: `{from: string}`, stamped by the relay — a peer can't
 * send as another.
 */

export type RelayClientControl = {
  readonly t: "join";
  readonly room: string;
  /** Chosen by the peer; the relay binds it to this socket for as long as it's open. */
  readonly peer: string;
  readonly token: string;
};

export type RelayServerControl =
  | { readonly t: "joined"; readonly peers: ReadonlyArray<string> }
  | { readonly t: "peer-join"; readonly peer: string }
  | { readonly t: "peer-leave"; readonly peer: string }
  | { readonly t: "error"; readonly message: string };

/** Close codes. The peer doesn't reconnect after these, as retrying can't help. */
export const RELAY_REFUSED = 4401;
/** A newer host tab joined the room. */
export const RELAY_HOST_REPLACED = 4409;
/** Over the connection's message or byte rate; the peer reconnects and joins again. */
export const RELAY_RATE_LIMITED = 4429;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(header: object, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + head.length + payload.length);
  new DataView(frame.buffer).setUint32(0, head.length);
  frame.set(head, 4);
  frame.set(payload, 4 + head.length);
  return frame;
}

export function decodeFrame<H>(frame: Uint8Array): { header: H; payload: Uint8Array } | null {
  if (frame.length < 4) return null;
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  if (4 + length > frame.length) return null;
  try {
    const header = JSON.parse(decoder.decode(frame.subarray(4, 4 + length))) as H;
    return { header, payload: frame.subarray(4 + length) };
  } catch {
    return null;
  }
}
