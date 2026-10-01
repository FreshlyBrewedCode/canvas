/**
 * This browser's key (ADR 0011, decision 1): a non-extractable ECDSA P-256
 * keypair, made the first time the browser opens canvas and kept in
 * IndexedDB, which stores the key objects themselves — the private half never
 * exists as bytes this app could read or leak. Its fingerprint is who we are
 * on every board (`shared/identity.ts`).
 */

import {
  KEY_ALGORITHM,
  SIGNATURE,
  fingerprint,
  peerStatement,
  toBase64Url,
  type PeerProof,
} from "../../shared/identity";

export interface BrowserKey {
  /** base64url raw point. */
  readonly publicKey: string;
  readonly fingerprint: string;
  /** Sign `text` with the private half; base64url. */
  sign(text: string): Promise<string>;
}

/** Where the keypair lives. */
export interface KeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  /** Keep `pair` unless one is kept already (another tab was quicker); the kept one. */
  keep(pair: CryptoKeyPair): Promise<CryptoKeyPair>;
}

export async function loadBrowserKey(store: KeyStore = indexedDbStore()): Promise<BrowserKey> {
  let pair = await store.get();
  if (!pair) {
    const made = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
    pair = await store.keep(made);
  }
  const { privateKey } = pair;
  const publicKey = toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    fingerprint: await fingerprint(publicKey),
    sign: async (text) =>
      toBase64Url(await crypto.subtle.sign(SIGNATURE, privateKey, new TextEncoder().encode(text))),
  };
}

/** Answer the host's join challenge: we are `peerId` in `roomId`. */
export async function provePeer(
  key: BrowserKey,
  roomId: string,
  peerId: string,
  nonce: string,
): Promise<PeerProof> {
  return {
    publicKey: key.publicKey,
    signature: await key.sign(peerStatement(roomId, peerId, nonce)),
  };
}

const DB = "canvas";
const STORE = "keys";
const SELF = "browser";

function indexedDbStore(): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = op(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  const get = () => run<CryptoKeyPair | undefined>("readonly", (s) => s.get(SELF));
  return {
    get,
    keep: async (pair) => {
      try {
        await run("readwrite", (s) => s.add(pair, SELF));
        return pair;
      } catch {
        return (await get()) ?? pair;
      }
    },
  };
}
