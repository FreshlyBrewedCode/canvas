import { describe, expect, test } from "bun:test";

import type { Knock } from "./admission";
import { arrivals, notices, type NoticeSources } from "./notices";
import type { Approval, OwnRequest } from "./room";

const knock = (peerId: string) => ({ peerId, name: peerId, color: "#000" }) as unknown as Knock;
const approval = (id: string) =>
  ({
    id,
    peerId: "p",
    peer: { name: "Ada", color: "#000" },
    request: { t: "agent-cancel", sessionId: "s" },
    resolve: () => {},
  }) as Approval;
const request = (id: string): OwnRequest => ({
  id,
  request: { t: "agent-prompt", sessionId: "s", frameId: "f", text: "hi" },
});

const none: NoticeSources = {
  isHost: true,
  knocks: [],
  approvals: [],
  waiting: [],
  requests: [],
  access: null,
};

describe("notices", () => {
  test("host: knocks, then guests' requests, then agents, each in the order it came", () => {
    const list = notices({
      ...none,
      knocks: [knock("k1"), knock("k2")],
      approvals: [approval("a1")],
      waiting: [{ id: "f1", title: "claude-1" }],
    });
    expect(list.map((n) => n.id)).toEqual(["knock:k1", "knock:k2", "approval:a1", "agent:f1"]);
  });

  test("guest: its own requests while they wait for an approval, then agents", () => {
    const guest = {
      ...none,
      isHost: false,
      requests: [request("r1")],
      waiting: [{ id: "f1", title: "claude-1" }],
    };
    const list = notices({ ...guest, access: "edit" });
    expect(list.map((n) => n.id)).toEqual(["request:r1", "agent:f1"]);
    // Trusted runs at once: nothing waits on the host.
    expect(notices({ ...guest, access: "trusted" }).map((n) => n.id)).toEqual(["agent:f1"]);
  });

  test("nothing waits: no notices", () => {
    expect(notices(none)).toEqual([]);
    expect(notices({ ...none, isHost: false, access: "edit" })).toEqual([]);
  });
});

describe("arrivals", () => {
  const list = notices({
    ...none,
    knocks: [knock("k1"), knock("k2")],
    approvals: [approval("a1"), approval("a2")],
    waiting: [{ id: "f1", title: "claude-1" }],
  });

  test("knocks and requests get a card, up to the most; agents never", () => {
    const { cards, more } = arrivals(list, new Set());
    expect(cards.map((n) => n.id)).toEqual(["knock:k1", "knock:k2", "approval:a1"]);
    expect(more).toBe(1);
  });

  test("one put off for later leaves the cards, and the next takes its place", () => {
    const { cards, more } = arrivals(list, new Set(["knock:k1"]));
    expect(cards.map((n) => n.id)).toEqual(["knock:k2", "approval:a1", "approval:a2"]);
    expect(more).toBe(0);
  });

  test("fewer than the most: all of them, none more", () => {
    expect(arrivals(list.slice(0, 1), new Set())).toEqual({
      cards: [list[0]!],
      more: 0,
    });
  });
});
