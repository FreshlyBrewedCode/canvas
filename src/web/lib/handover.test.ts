import { describe, expect, test } from "bun:test";

import { toBase64Url } from "../../shared/identity";
import { makeSealKey, openMove, sealMove, type Move } from "./handover";

/** A board's host keypair, as `canvas serve` mints it. */
async function hostKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

const move: Move = {
  roomId: "room-2",
  key: "key-2",
  relay: { url: "wss://relay.example", via: "transport", token: "v1.t.r.g.1.s" },
};

describe("handing the new room over", () => {
  test("the member it is sealed to opens it", async () => {
    const host = await hostKey();
    const ada = await makeSealKey();
    const sealed = await sealMove(host.privateKey, "room-1", "peer-a", ada.publicKey, move);
    expect(await openMove(ada, host.publicKey, "room-1", "peer-a", sealed)).toEqual(move);
  });

  test("nobody else does: not another member, not someone holding the old room key", async () => {
    const host = await hostKey();
    const ada = await makeSealKey();
    const bob = await makeSealKey();
    const sealed = await sealMove(host.privateKey, "room-1", "peer-a", ada.publicKey, move);
    expect(await openMove(bob, host.publicKey, "room-1", "peer-a", sealed)).toBeNull();
    expect(JSON.stringify(sealed)).not.toContain(move.key);
  });

  test("it must be the host's, for us, in the room we are in", async () => {
    const host = await hostKey();
    const other = await hostKey();
    const ada = await makeSealKey();
    const forgeries = [
      // Sealed to Ada by someone without the host key.
      await sealMove(other.privateKey, "room-1", "peer-a", ada.publicKey, move),
      // The host's, for another peer, or from another room: replayed.
      await sealMove(host.privateKey, "room-1", "peer-b", ada.publicKey, move),
      await sealMove(host.privateKey, "room-0", "peer-a", ada.publicKey, move),
    ];
    for (const sealed of forgeries)
      expect(await openMove(ada, host.publicKey, "room-1", "peer-a", sealed)).toBeNull();
  });

  test("anything malformed is refused, not thrown", async () => {
    const host = await hostKey();
    const ada = await makeSealKey();
    const sealed = await sealMove(host.privateKey, "room-1", "peer-a", ada.publicKey, move);
    const broken = [
      { ...sealed, data: `${sealed.data.slice(0, -4)}AAAA` },
      { ...sealed, from: "x" },
      { ...sealed, iv: "" },
      null as never,
    ];
    for (const bad of broken)
      expect(await openMove(ada, host.publicKey, "room-1", "peer-a", bad)).toBeNull();
  });

  test("a board without a relay moves without one", async () => {
    const host = await hostKey();
    const ada = await makeSealKey();
    const bare = { ...move, relay: null };
    const sealed = await sealMove(host.privateKey, "room-1", "peer-a", ada.publicKey, bare);
    expect(await openMove(ada, host.publicKey, "room-1", "peer-a", sealed)).toEqual(bare);
  });
});
