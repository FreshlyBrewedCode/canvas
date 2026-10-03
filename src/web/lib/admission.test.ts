import { describe, expect, test } from "bun:test";

import type { GuestRequest, Member, MemberRole } from "../../shared/protocol";
import { Admissions, check, mayEdit } from "./admission";

const ada = { publicKey: "key-ada", fingerprint: "a".repeat(32) };
const bob = { publicKey: "key-bob", fingerprint: "b".repeat(32) };
const who = { name: "Ada", color: "#3b82f6" };
const member = (id: typeof ada, role: MemberRole): Member => ({
  ...id,
  name: "x",
  role,
  admitted: "2026-10-01T00:00:00.000Z",
});
const prompt: GuestRequest = { t: "agent-prompt", sessionId: "s", text: "hi" };

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
    expect(check("edit", { t: "agent-create", frameId: "f", agent: "claude" })).toEqual({
      ok: true,
      approve: true,
    });
    expect(check("edit", { t: "agent-cancel", sessionId: "s" })).toEqual({
      ok: true,
      approve: false,
    });
    expect(check("edit", { t: "term-input", id: "t", data: "ls\n" }).ok).toBe(false);
  });
});
