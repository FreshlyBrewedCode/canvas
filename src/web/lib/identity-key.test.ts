import { describe, expect, test } from "bun:test";

import {
  PeerIdentities,
  fingerprint,
  peerStatement,
  readable,
  readableFull,
  verify,
} from "../../shared/identity";
import { loadBrowserKey, provePeer, type KeyStore } from "./identity-key";

/** IndexedDB, as far as the key needs it. */
const memoryStore = (): KeyStore & { pair?: CryptoKeyPair } => {
  const store: KeyStore & { pair?: CryptoKeyPair } = {
    get: async () => store.pair,
    keep: async (pair) => (store.pair ??= pair),
  };
  return store;
};

describe("browser key", () => {
  test("is made once and kept: loading again is the same key", async () => {
    const store = memoryStore();
    const first = await loadBrowserKey(store);
    const again = await loadBrowserKey(store);
    expect(again.publicKey).toBe(first.publicKey);
    expect(again.fingerprint).toBe(first.fingerprint);
  });

  test("another browser has another key", async () => {
    const a = await loadBrowserKey(memoryStore());
    const b = await loadBrowserKey(memoryStore());
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("its private half can't be read out", async () => {
    const store = memoryStore();
    await loadBrowserKey(store);
    await expect(crypto.subtle.exportKey("jwk", store.pair!.privateKey)).rejects.toThrow();
  });

  test("a tab that loses the race to keep its key uses the one kept", async () => {
    const store = memoryStore();
    const first = await loadBrowserKey(store);
    const late = await loadBrowserKey({ get: async () => undefined, keep: store.keep });
    expect(late.publicKey).toBe(first.publicKey);
  });

  test("signs what it is asked to", async () => {
    const key = await loadBrowserKey(memoryStore());
    const signature = await key.sign("challenge");
    expect(await verify(key.publicKey, "challenge", signature)).toBe(true);
    expect(await verify(key.publicKey, "another", signature)).toBe(false);
  });
});

describe("fingerprint", () => {
  test("is a stable hash of the public key, read as two groups", async () => {
    const key = await loadBrowserKey(memoryStore());
    expect(key.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await fingerprint(key.publicKey)).toBe(key.fingerprint);
    expect(readable(key.fingerprint)).toBe(
      `${key.fingerprint.slice(0, 4)} ${key.fingerprint.slice(4, 8)}`,
    );
  });

  test("its full form is all of it, in groups of four", () => {
    const full = readableFull("0123456789abcdef0123456789abcdef");
    expect(full).toBe("0123 4567 89ab cdef 0123 4567 89ab cdef");
  });
});

describe("join statement", () => {
  test("names the room, the peer and the nonce", () => {
    expect(peerStatement("room-1", "peer-a", "n0")).toBe("canvas-peer:room-1:peer-a:n0");
  });

  test("a peer's proof verifies, and the host knows its fingerprint", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    const nonce = book.challenge("peer-a");
    const identity = await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", nonce));
    expect(identity).toEqual({ publicKey: key.publicKey, fingerprint: key.fingerprint });
    expect(book.get("peer-a")?.fingerprint).toBe(key.fingerprint);
    expect(book.fingerprints()).toEqual({ "peer-a": key.fingerprint });
  });

  test("a forged statement doesn't verify", async () => {
    const key = await loadBrowserKey(memoryStore());
    const other = await loadBrowserKey(memoryStore());
    const forgeries = [
      // Signed for another peer id, another room, another nonce.
      (nonce: string) => provePeer(key, "room-1", "peer-b", nonce),
      (nonce: string) => provePeer(key, "room-2", "peer-a", nonce),
      () => provePeer(key, "room-1", "peer-a", "stale"),
      // Someone else's key, claimed as ours.
      async (nonce: string) => ({
        ...(await provePeer(other, "room-1", "peer-a", nonce)),
        publicKey: key.publicKey,
      }),
      // Not a signature at all.
      async () => ({ publicKey: key.publicKey, signature: "x" }),
    ];
    for (const forge of forgeries) {
      const book = new PeerIdentities("room-1");
      const nonce = book.challenge("peer-a");
      expect(await book.prove("peer-a", await forge(nonce))).toBeNull();
      expect(book.get("peer-a")).toBeUndefined();
    }
  });

  test("a nonce is good once, and only the latest", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    const old = book.challenge("peer-a");
    const nonce = book.challenge("peer-a");
    expect(await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", old))).toBeNull();
    const proof = await provePeer(key, "room-1", "peer-a", nonce);
    // The failed try used the nonce up.
    expect(await book.prove("peer-a", proof)).toBeNull();
    const fresh = book.challenge("peer-a");
    const replay = await provePeer(key, "room-1", "peer-a", fresh);
    expect(await book.prove("peer-a", replay)).not.toBeNull();
    expect(await book.prove("peer-a", replay)).toBeNull();
  });

  test("a peer that leaves is forgotten", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    const nonce = book.challenge("peer-a");
    await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", nonce));
    book.forget("peer-a");
    expect(book.get("peer-a")).toBeUndefined();
    expect(book.fingerprints()).toEqual({});
  });

  test("an unasked proof is refused", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    expect(await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", "n"))).toBeNull();
  });
});

describe("peers that come and go", () => {
  test("a proof still being checked when its peer leaves doesn't count", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    const proof = await provePeer(key, "room-1", "peer-a", book.challenge("peer-a"));
    const checking = book.prove("peer-a", proof);
    book.forget("peer-a");
    expect(await checking).toBeNull();
    expect(book.get("peer-a")).toBeUndefined();
  });

  test("a peer that comes back under its id proves itself again", async () => {
    const key = await loadBrowserKey(memoryStore());
    const book = new PeerIdentities("room-1");
    await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", book.challenge("peer-a")));
    book.forget("peer-a");
    const nonce = book.challenge("peer-a");
    expect(
      await book.prove("peer-a", await provePeer(key, "room-1", "peer-a", nonce)),
    ).not.toBeNull();
  });
});
