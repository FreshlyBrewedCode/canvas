import { describe, expect, test } from "bun:test";

import { Store } from "../../server/store";
import { signHost, verifyHost } from "./host-key";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("host key", async () => {
  // The same keys `canvas serve` mints for a board.
  const room = await new Store(mkdtempSync(join(tmpdir(), "canvas-key-"))).room();

  test("a signature over the host's peer id verifies", async () => {
    const signature = await signHost(room.hostPrivateKey, room.roomId, "peer-a");
    expect(await verifyHost(room.hostPublicKey, room.roomId, "peer-a", signature)).toBe(true);
  });

  test("a replayed signature does not make another peer the host", async () => {
    const signature = await signHost(room.hostPrivateKey, room.roomId, "peer-a");
    expect(await verifyHost(room.hostPublicKey, room.roomId, "peer-b", signature)).toBe(false);
    expect(await verifyHost(room.hostPublicKey, "other-room", "peer-a", signature)).toBe(false);
  });
});
