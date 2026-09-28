import { afterAll, describe, expect, test } from "bun:test";

import { startRelay } from "../../../server/relay";
import { signRelayToken } from "../../../server/relay-token";
import { relayRoom } from "../../../shared/relay-room";
import { boardCipher } from "./envelope";
import { relayTransport } from "./relay";

const issuer = { name: "team", secret: "s3cret" };
const relay = startRelay({
  port: 0,
  hostname: "127.0.0.1",
  issuers: new Map([[issuer.name, issuer.secret]]),
});
const url = `ws://127.0.0.1:${relay.port}`;
afterAll(() => relay.stop(true));

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function peer(boardKey: string, selfId: string, role: "host" | "guest", token?: string) {
  const errors: string[] = [];
  const room = await relayRoom(boardKey);
  const transport = relayTransport(
    {
      url,
      token: token ?? signRelayToken(issuer, room, role),
      boardKey,
      selfId,
    },
    (error) => errors.push(error),
  );
  const joined: string[] = [];
  const left: string[] = [];
  transport.onPeerJoin = (id) => joined.push(id);
  transport.onPeerLeave = (id) => left.push(id);
  return { transport, errors, joined, left };
}

describe("relay transport", () => {
  test("peers of a board meet, message each other and ask each other", async () => {
    const host = await peer("board-a", "host1", "host");
    const guest = await peer("board-a", "guest1", "guest");
    await until(() => host.joined.includes("guest1") && guest.joined.includes("host1"));

    const got: Array<[unknown, string]> = [];
    guest.transport.channel<unknown>("chat").onMessage = (data, { peerId }) => {
      got.push([data, peerId]);
    };
    await host.transport.channel("chat").send({ hello: "all" });
    await host.transport.channel("chat").send(new Uint8Array([1, 2, 3]), { target: "guest1" });
    await until(() => got.length === 2);
    expect(got[0]).toEqual([{ hello: "all" }, "host1"]);
    expect(got[1]![0]).toEqual(new Uint8Array([1, 2, 3]));

    host.transport.requests<{ n: number }, { twice: number }>("ask").onRequest = ({ n }) => ({
      twice: n * 2,
    });
    const reply = await guest.transport
      .requests<{ n: number }, { twice: number }>("ask")
      .request({ n: 21 }, { target: "host1" });
    expect(reply).toEqual({ twice: 42 });

    host.transport.requests("fail").onRequest = () => {
      throw new Error("declined");
    };
    await expect(guest.transport.requests("fail").request({}, { target: "host1" })).rejects.toThrow(
      "declined",
    );

    guest.transport.leave();
    await until(() => host.left.includes("guest1"));
    host.transport.leave();
    expect([...host.errors, ...guest.errors]).toEqual([]);
  });

  test("a burst of sends arrives whole and in order", async () => {
    // As `room.ts` sends: without waiting for each one.
    const host = await peer("board-h", "h1", "host");
    const guest = await peer("board-h", "g1", "guest");
    await until(() => host.joined.includes("g1"));
    const got: number[] = [];
    guest.transport.channel<number>("tick").onMessage = (n) => {
      got.push(n);
    };
    for (let i = 0; i < 500; i++) void host.transport.channel("tick").send(i);
    await until(() => got.length === 500);
    expect(got).toEqual([...Array(500).keys()]);
    expect(guest.errors).toEqual([]);
    host.transport.leave();
    guest.transport.leave();
  });

  test("a request waiting on its answer doesn't hold up other messages", async () => {
    const host = await peer("board-i", "h1", "host");
    const guest = await peer("board-i", "g1", "guest");
    await until(() => host.joined.includes("g1"));
    let approve = () => {};
    host.transport.requests("run").onRequest = () =>
      new Promise((resolve) => (approve = () => resolve("ran")));
    const chat: string[] = [];
    host.transport.channel<string>("chat").onMessage = (text) => {
      chat.push(text);
    };
    const reply = guest.transport.requests("run").request({}, { target: "h1" });
    await guest.transport.channel("chat").send("meanwhile");
    await until(() => chat.length === 1);
    approve();
    expect(await reply).toBe("ran");
    host.transport.leave();
    guest.transport.leave();
  });

  test("boards on one relay don't hear each other", async () => {
    const a = await peer("board-b", "a1", "host");
    const b = await peer("board-c", "b1", "host");
    const a2 = await peer("board-b", "a2", "guest");
    await until(() => a.joined.includes("a2"));
    await new Promise((r) => setTimeout(r, 100));
    expect(b.joined).toEqual([]);
    for (const p of [a, b, a2]) p.transport.leave();
  });

  test("the relay refuses a token for another room, from an unknown issuer, or expired", async () => {
    const other = signRelayToken(issuer, await relayRoom("elsewhere"), "guest");
    const stranger = signRelayToken(
      { name: "stranger", secret: "x" },
      await relayRoom("board-d"),
      "guest",
    );
    const old = signRelayToken(
      issuer,
      await relayRoom("board-d"),
      "guest",
      Date.now() - 31 * 86_400_000,
    );
    for (const [token, reason] of [
      [other, "for another room"],
      [stranger, "unknown issuer stranger"],
      [old, "expired"],
    ] as const) {
      const p = await peer("board-d", "g1", "guest", token);
      await until(() => p.errors.some((e) => e.includes(reason)));
      p.transport.leave();
    }
  });

  test("a newer host tab takes the room over", async () => {
    const first = await peer("board-e", "tab1", "host");
    await until(() => first.transport.diagnostics().relays[0]?.state === "open");
    const second = await peer("board-e", "tab2", "host");
    await until(() => first.errors.some((e) => e.includes("another host tab joined")));
    second.transport.leave();
  });
});

describe("envelope", () => {
  test("drops what was tampered with, re-sent, attributed to another, or stale", async () => {
    const room = await relayRoom("board-f");
    const alice = await boardCipher("board-f", room);
    const bob = await boardCipher("board-f", room);
    const sealed = await alice.seal("alice", { channel: "c", kind: "message", body: { x: 1 } });

    expect(await bob.open("alice", sealed)).toEqual({
      envelope: { channel: "c", kind: "message", body: { x: 1 } },
    });
    expect(await bob.open("alice", sealed)).toEqual({ dropped: "seen before: a replay" });

    const next = await alice.seal("alice", { channel: "c", kind: "message", body: 2 });
    expect(await bob.open("mallory", next)).toMatchObject({
      dropped: expect.stringContaining("relayed as from mallory"),
    });

    const tampered = await alice.seal("alice", { channel: "c", kind: "message", body: 3 });
    tampered[20]! ^= 1;
    expect(await bob.open("alice", tampered)).toEqual({
      dropped: "doesn't decrypt with this board's key",
    });

    const stale = await alice.seal(
      "alice",
      { channel: "c", kind: "message", body: 4 },
      Date.now() - 300_000,
    );
    expect(await bob.open("alice", stale)).toEqual({ dropped: "too old: a replay?" });

    const otherBoard = await boardCipher("board-g", await relayRoom("board-g"));
    const fresh = await alice.seal("alice", { channel: "c", kind: "message", body: 5 });
    expect(await otherBoard.open("alice", fresh)).toEqual({
      dropped: "doesn't decrypt with this board's key",
    });
  });
});
