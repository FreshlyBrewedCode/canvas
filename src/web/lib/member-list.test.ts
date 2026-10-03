import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../../server/store";
import { signHost } from "./host-key";
import { Members, nextVersion, signMembers, type MemberList } from "./member-list";

describe("the signed member list", async () => {
  // The same keys `canvas serve` mints for a board.
  const room = await new Store(mkdtempSync(join(tmpdir(), "canvas-members-"))).room();
  const sign = (list: MemberList) => signMembers(room.hostPrivateKey, room.roomId, list);
  const guest = (self = "guest-a") => new Members(room.roomId, room.hostPublicKey, self);
  const list = (version: number, members: Record<string, string>, host = "host"): MemberList => ({
    host,
    version,
    members: { host: "fh", ...members },
  });

  test("a list the host key signed is taken; who joined and left it", async () => {
    const members = guest();
    expect(await members.accept(await sign(list(1, { "guest-a": "fa" })), "host")).toEqual({
      added: ["host"],
      removed: [],
    });
    const next = list(2, { "guest-a": "fa", "guest-b": "fb" });
    expect(await members.accept(await sign(next), "host")).toEqual({
      added: ["guest-b"],
      removed: [],
    });
    expect(members.fingerprints()).toEqual(next.members);
    expect(await members.accept(await sign(list(3, { "guest-a": "fa" })), "host")).toEqual({
      added: [],
      removed: ["guest-b"],
    });
  });

  test("an unsigned, forged or tampered list is refused", async () => {
    const members = guest();
    const signed = await sign(list(1, { "guest-a": "fa" }));
    expect(await members.accept({ list: signed.list } as never, "host")).toBeNull();
    expect(await members.accept({ list: signed.list, signature: "" }, "host")).toBeNull();
    const tampered = signed.list.replace('"guest-a":"fa"', '"guest-a":"fa","lobby":"fx"');
    expect(await members.accept({ ...signed, list: tampered }, "host")).toBeNull();
    // The host's hello signature is over another statement: it signs no list.
    const hello = await signHost(room.hostPrivateKey, room.roomId, "host");
    expect(await members.accept({ list: signed.list, signature: hello }, "host")).toBeNull();
    expect(members.peers()).toEqual([]);
  });

  test("an old list is refused, even when it arrives last", async () => {
    const members = guest();
    const older = await sign(list(1, { "guest-a": "fa", "guest-b": "fb" }));
    const newer = await sign(list(2, { "guest-a": "fa" }));
    expect(await members.accept(newer, "host")).not.toBeNull();
    expect(await members.accept(older, "host")).toBeNull();
    expect(await members.accept(newer, "host")).toBeNull();
    expect(members.has("guest-b")).toBe(false);
  });

  test("a list is only taken from the host it names", async () => {
    const members = guest();
    const signed = await sign(list(5, { "guest-a": "fa" }, "old-host"));
    expect(await members.accept(signed, "host")).toBeNull();
    expect(await members.accept(signed, "old-host")).not.toBeNull();
    // A new host session starts its versions over, whatever its clock says.
    expect(await members.accept(await sign(list(1, { "guest-a": "fa" })), "host")).not.toBeNull();
  });

  test("presence goes to and comes from peers on the list only", async () => {
    const members = guest();
    expect(members.has("host")).toBe(false);
    await members.accept(await sign(list(1, { "guest-a": "fa", "guest-b": "fb" })), "host");
    expect(members.peers().sort()).toEqual(["guest-b", "host"]);
    expect(members.has("guest-b")).toBe(true);
    expect(members.has("lobby")).toBe(false);
    expect(members.has("guest-a")).toBe(false);
  });

  test("off the list, nobody's presence: a guest in the lobby, or cut off", async () => {
    const lobby = guest("lobby");
    await lobby.accept(await sign(list(1, { "guest-a": "fa", "guest-b": "fb" })), "host");
    expect(lobby.peers()).toEqual([]);
    expect(lobby.has("guest-a")).toBe(false);

    const cut = guest();
    await cut.accept(await sign(list(1, { "guest-a": "fa", "guest-b": "fb" })), "host");
    expect(await cut.accept(await sign(list(2, { "guest-b": "fb" })), "host")).toEqual({
      added: [],
      removed: ["host", "guest-b"],
    });
    expect(cut.has("guest-b")).toBe(false);
  });

  test("versions grow, also when the clock doesn't", () => {
    expect(nextVersion(0, 1000)).toBe(1000);
    expect(nextVersion(1000, 1000)).toBe(1001);
    expect(nextVersion(2000, 1000)).toBe(2001);
  });
});
