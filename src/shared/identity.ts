/**
 * Who a peer is (ADR 0011, decision 1): a key per browser, seen by its
 * fingerprint. Plain WebCrypto, for both halves: the host's browser checks
 * guests with it, and `canvas serve` can check the host's browser.
 *
 * A peer proves its key on join by signing `canvas-peer:<room>:<peer id>:<nonce>`
 * with a nonce the host gave it, which binds the peer id to the key the way
 * `web/lib/host-key.ts` binds the host's. The browser half — making and
 * keeping the key — is `web/lib/identity-key.ts`.
 */

export const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
export const SIGNATURE = { name: "ECDSA", hash: "SHA-256" } as const;

export const toBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** A fresh random challenge, base64url. */
export const nonce = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

/**
 * The stable id of a public key (base64url raw point): the first 16 bytes of
 * its SHA-256, in hex.
 */
export async function fingerprint(publicKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey));
  return [...new Uint8Array(hash).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A fingerprint as people see it: `ab12 cd34`. */
export const readable = (fingerprint: string) =>
  `${fingerprint.slice(0, 4)} ${fingerprint.slice(4, 8)}`;

/**
 * All of a fingerprint, in groups of four: where telling browsers apart
 * matters (admitting one), as the short form is only 32 bits.
 */
export const readableFull = (fingerprint: string) => fingerprint.match(/.{1,4}/g)?.join(" ") ?? "";

export const peerStatement = (roomId: string, peerId: string, nonce: string) =>
  `canvas-peer:${roomId}:${peerId}:${nonce}`;

/** What the host's browser signs for `canvas serve`'s challenge (ADR 0011, decision 3). */
export const ownerStatement = (roomId: string, nonce: string) => `canvas-owner:${roomId}:${nonce}`;

/** Whether `signature` (base64url) is `publicKey`'s over `text`; false for anything malformed. */
export async function verify(publicKey: string, text: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKey),
      KEY_ALGORITHM,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      SIGNATURE,
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}

/** What a peer sends back for the host's nonce. */
export interface PeerProof {
  readonly publicKey: string;
  readonly signature: string;
}

export interface PeerIdentity {
  readonly publicKey: string;
  readonly fingerprint: string;
}

/**
 * The host's book of who each connected peer is: it hands out one nonce per
 * peer and keeps the identities whose proof verified. A nonce is good once.
 */
export class PeerIdentities {
  private readonly nonces = new Map<string, string>();
  private readonly verified = new Map<string, PeerIdentity>();
  /** Nonces whose answer is being checked: gone if the peer leaves or is challenged again. */
  private readonly checking = new Map<string, string>();

  constructor(private readonly roomId: string) {}

  /** A nonce for `peerId` to sign; a new one replaces the last. */
  challenge(peerId: string): string {
    const value = nonce();
    this.nonces.set(peerId, value);
    this.checking.delete(peerId);
    return value;
  }

  /** Check `peerId`'s answer to its challenge; its identity if it holds. */
  async prove(peerId: string, proof: PeerProof): Promise<PeerIdentity | null> {
    const value = this.nonces.get(peerId);
    if (!value || typeof proof?.publicKey !== "string" || typeof proof.signature !== "string")
      return null;
    this.nonces.delete(peerId);
    this.checking.set(peerId, value);
    const statement = peerStatement(this.roomId, peerId, value);
    const ok = await verify(proof.publicKey, statement, proof.signature);
    const identity = ok && {
      publicKey: proof.publicKey,
      fingerprint: await fingerprint(proof.publicKey),
    };
    // Unless it left, or was challenged again, meanwhile.
    const current = this.checking.get(peerId) === value;
    if (current) this.checking.delete(peerId);
    if (!identity || !current) return null;
    this.verified.set(peerId, identity);
    return identity;
  }

  /** The verified identity of a connected peer. */
  get(peerId: string): PeerIdentity | undefined {
    return this.verified.get(peerId);
  }

  /** The peer left. */
  forget(peerId: string) {
    this.nonces.delete(peerId);
    this.verified.delete(peerId);
    this.checking.delete(peerId);
  }

  clear() {
    this.nonces.clear();
    this.verified.clear();
    this.checking.clear();
  }

  /** Every verified peer's fingerprint, by peer id. */
  fingerprints(): Record<string, string> {
    return Object.fromEntries([...this.verified].map(([peerId, id]) => [peerId, id.fingerprint]));
  }
}
