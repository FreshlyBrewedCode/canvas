import { describe, expect, test } from "bun:test";

import type { GuestRequest, Member, MemberRole } from "../../shared/protocol";
import { Admissions, check, mayEdit } from "./admission";

const ada = { publicKey: "key-ada", fingerprint: "a".repeat(32), sealKey: "seal-ada" };
const bob = { publicKey: "key-bob", fingerprint: "b".repeat(32), sealKey: "seal-bob" };
const who = { name: "Ada", color: "#3b82f6" };
const member = ({ publicKey, fingerprint }: typeof ada, role: MemberRole): Member => ({
  publicKey,
  fingerprint,
  name: "x",
  role,
  admitted: "2026-10-01T00:00:00.000Z",
});
const prompt: GuestRequest = { t: "agent-prompt", sessionId: "s", frameId: "f", text: "hi" };

describe("admission", () => {
  test("a browser the host doesn't know knocks, and is nowhere in until admitted", () => {
    const book = new Admissions();
    expect(book.arrive("p1", ada, who)).toEqual([
      { t: "knock", knock: { peerId: "p1", ...ada, ...who } },
    ]);
    expect(book.access("p1")).toBeNull();
    expect(book.admitted()).toEqual([]);
    expect(book.fingerprints()).toEqual({});
    expect(book.knocks().map((k) => k.peerId)).toEqual(["p1"]);

    expect(book.setMembers([member(ada, "view")])).toEqual([
      { t: "admit", peerId: "p1", access: "view" },
    ]);
    expect(book.access("p1")).toBe("view");
    expect(book.knocks()).toEqual([]);
    expect(book.fingerprints()).toEqual({ p1: ada.fingerprint });
  });

  test("a member is in at once, with its role", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit")]);
    expect(book.arrive("p1", ada, who)).toEqual([{ t: "admit", peerId: "p1", access: "edit" }]);
    expect(book.admitted()).toEqual(["p1"]);
  });

  test("members are found by the full fingerprint and the key, not the short form", () => {
    const book = new Admissions();
    const lookalike = {
      publicKey: "key-eve",
      fingerprint: `${ada.fingerprint.slice(0, 8)}${"e".repeat(24)}`,
      sealKey: "seal-eve",
    };
    book.setMembers([member(ada, "edit")]);
    expect(book.arrive("p1", lookalike, who)[0]!.t).toBe("knock");
    expect(book.arrive("p2", { ...ada, publicKey: "other" }, who)[0]!.t).toBe("knock");
  });

  test("a role change takes hold at once", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit")]);
    book.arrive("p1", ada, who);
    expect(book.setMembers([member(ada, "view")])).toEqual([
      { t: "access", peerId: "p1", access: "view", was: "edit" },
    ]);
    expect(book.access("p1")).toBe("view");
    expect(book.setMembers([member(ada, "view"), member(bob, "edit")])).toEqual([]);
  });

  test("removing a member cuts its peers off, and they stay out on this connection", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit"), member(bob, "edit")]);
    book.arrive("p1", ada, who);
    book.arrive("p2", bob, who);
    expect(book.setMembers([member(bob, "edit")])).toEqual([{ t: "cut", peerId: "p1" }]);
    expect(book.access("p1")).toBeNull();
    expect(book.isDropped("p1")).toBe(true);
    expect(book.admitted()).toEqual(["p2"]);
    // Admitted again meanwhile, it still has to come again (a new peer id) to be in.
    book.setMembers([member(ada, "edit"), member(bob, "edit")]);
    expect(book.arrive("p1", ada, who)).toEqual([]);
    expect(book.arrive("p3", ada, who)).toEqual([{ t: "admit", peerId: "p3", access: "edit" }]);
  });

  test("a denied knock is dropped; members can't be denied", () => {
    const book = new Admissions();
    book.setMembers([member(bob, "edit")]);
    book.arrive("p1", ada, who);
    book.arrive("p2", bob, who);
    expect(book.deny("p2")).toBe(false);
    expect(book.deny("p1")).toBe(true);
    expect(book.knocks()).toEqual([]);
    expect(book.isDropped("p1")).toBe(true);
    // Admitting the key later doesn't let the denied peer in.
    expect(book.setMembers([member(ada, "edit"), member(bob, "edit")])).toEqual([]);
    expect(book.access("p1")).toBeNull();
  });

  test("a peer that leaves is forgotten; clear starts over", () => {
    const book = new Admissions();
    book.arrive("p1", ada, who);
    book.arrive("p2", bob, who);
    book.deny("p2");
    book.leave("p1");
    expect(book.knocks()).toEqual([]);
    book.clear();
    expect(book.isDropped("p2")).toBe(false);
  });
});

describe("trusted for one host session (decision 4)", () => {
  test("granted on top of the saved role, taken back to it", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit"), member(bob, "view")]);
    book.arrive("p1", ada, who);
    book.arrive("p2", bob, who);
    expect(book.trust(ada.fingerprint, true)).toEqual([
      { t: "access", peerId: "p1", access: "trusted", was: "edit" },
    ]);
    expect(book.access("p1")).toBe("trusted");
    expect(book.isTrusted(ada.fingerprint)).toBe(true);
    expect(book.access("p2")).toBe("view");
    expect(book.trust(ada.fingerprint, false)).toEqual([
      { t: "access", peerId: "p1", access: "edit", was: "trusted" },
    ]);
    expect(book.isTrusted(ada.fingerprint)).toBe(false);
  });

  test("per member: a peer that comes again (a guest reload) is trusted at once", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit")]);
    expect(book.trust(ada.fingerprint, true)).toEqual([]);
    expect(book.arrive("p1", ada, who)).toEqual([{ t: "admit", peerId: "p1", access: "trusted" }]);
    book.leave("p1");
    expect(book.arrive("p2", ada, who)).toEqual([{ t: "admit", peerId: "p2", access: "trusted" }]);
  });

  test("only members are trusted; a role change keeps it, a removal drops it", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit")]);
    expect(book.trust(bob.fingerprint, true)).toEqual([]);
    expect(book.isTrusted(bob.fingerprint)).toBe(false);
    book.trust(ada.fingerprint, true);
    book.arrive("p1", ada, who);
    expect(book.setMembers([member(ada, "view")])).toEqual([]);
    expect(book.access("p1")).toBe("trusted");
    book.setMembers([]);
    expect(book.isTrusted(ada.fingerprint)).toBe(false);
    // Admitted again, it has its saved role only.
    book.setMembers([member(ada, "edit")]);
    expect(book.arrive("p2", ada, who)).toEqual([{ t: "admit", peerId: "p2", access: "edit" }]);
  });

  test("never saved: the member list keeps the role, and a new host session starts without it", () => {
    const members = [member(ada, "edit")];
    const book = new Admissions();
    book.setMembers(members);
    book.trust(ada.fingerprint, true);
    expect(members[0]!.role).toBe("edit");
    // The host tab reloads: a new room, a new book, the same saved members.
    const next = new Admissions();
    next.setMembers(members);
    expect(next.arrive("p1", ada, who)).toEqual([{ t: "admit", peerId: "p1", access: "edit" }]);
    // Stepping down (another tab is the host) ends the session too.
    book.clear();
    expect(book.isTrusted(ada.fingerprint)).toBe(false);
  });
});

describe("resetting the invite link (decision 6)", () => {
  test("the new room goes to the members in, each to its own seal key; nobody else", () => {
    const eve = { publicKey: "key-eve", fingerprint: "e".repeat(32), sealKey: "seal-eve" };
    const cy = { publicKey: "key-cy", fingerprint: "c".repeat(32), sealKey: "seal-cy" };
    const book = new Admissions();
    book.setMembers([member(ada, "view"), member(bob, "edit"), member(cy, "edit")]);
    book.arrive("p1", ada, who);
    book.arrive("p2", bob, who);
    book.arrive("p3", eve, who);
    book.arrive("p4", { ...eve, sealKey: "seal-eve-2" }, who);
    book.deny("p4");
    book.arrive("p5", cy, who);
    // Cy is removed: cut off, and left behind.
    book.setMembers([member(ada, "view"), member(bob, "edit")]);
    expect(book.moving()).toEqual([
      { peerId: "p1", sealKey: "seal-ada" },
      { peerId: "p2", sealKey: "seal-bob" },
    ]);
  });

  test("moved: everyone comes again; trust stays, for the session goes on", () => {
    const book = new Admissions();
    book.setMembers([member(ada, "edit")]);
    book.trust(ada.fingerprint, true);
    book.arrive("p1", ada, who);
    book.moved();
    expect(book.admitted()).toEqual([]);
    expect(book.moving()).toEqual([]);
    expect(book.arrive("p1", ada, who)).toEqual([{ t: "admit", peerId: "p1", access: "trusted" }]);
  });
});

describe("the authority's checks", () => {
  test("lobby peers: no edits, no requests", () => {
    expect(mayEdit(null)).toBe(false);
    expect(check(null, prompt)).toEqual({ ok: false, error: "the host hasn't let you in" });
    expect(check(null, { t: "agent-cancel", sessionId: "s" }).ok).toBe(false);
  });

  test("view members: no edits, no requests", () => {
    expect(mayEdit("view")).toBe(false);
    expect(check("view", prompt).ok).toBe(false);
    expect(check("view", { t: "agent-cancel", sessionId: "s" }).ok).toBe(false);
  });

  test("edit members: edits; runs wait for the host, stopping doesn't; no terminals", () => {
    expect(mayEdit("edit")).toBe(true);
    expect(check("edit", prompt)).toEqual({ ok: true, approve: true });
    expect(check("edit", { t: "agent-config", sessionId: "s", configId: "m", value: "x" })).toEqual(
      { ok: true, approve: true },
    );
    expect(check("edit", { t: "agent-cancel", sessionId: "s" })).toEqual({
      ok: true,
      approve: false,
    });
    expect(check("edit", { t: "term-input", pty: "t", data: "ls\n" }).ok).toBe(false);
  });

  test("trusted: edits; runs without the approval click; terminals", () => {
    expect(mayEdit("trusted")).toBe(true);
    expect(check("trusted", prompt)).toEqual({ ok: true, approve: false });
    expect(check("trusted", { t: "term-input", pty: "t", data: "ls\n" })).toEqual({
      ok: true,
      approve: false,
    });
  });
});
