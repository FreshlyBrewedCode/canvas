import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEY_ALGORITHM, SIGNATURE, ownerStatement, toBase64Url } from "../shared/identity";
import { AUTH_REFUSED, HOST_REPLACED, type ServerToClient } from "../shared/protocol";
import { relayRoom } from "../shared/relay-room";
import { verifyRelayToken } from "./relay-token";
import { serve, type ServeRelay } from "./server";

const until = async (what: string, test: () => boolean) => {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
};

/** A browser's key, as `web/lib/identity-key.ts` makes it. */
async function browserKey() {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
  const publicKey = toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (text: string) =>
    toBase64Url(
      await crypto.subtle.sign(SIGNATURE, pair.privateKey, new TextEncoder().encode(text)),
    );
  return { publicKey, sign };
}
type Key = Awaited<ReturnType<typeof browserKey>>;

interface Tab {
  readonly ws: WebSocket;
  readonly received: ServerToClient[];
  closed: number | null;
  reason: string;
}
const got = (tab: Tab, t: ServerToClient["t"]) => tab.received.some((m) => m.t === t);

async function start(relay?: ServeRelay) {
  const dir = mkdtempSync(join(tmpdir(), "canvas-server-"));
  writeFileSync(join(dir, "README.md"), "# hi\n");
  const served = await serve({ dir, port: 0, hostname: "127.0.0.1", ...(relay && { relay }) });
  afterAll(() => void served.server.stop(true));
  /** A socket that hasn't answered anything yet, once challenged. */
  const open = async (): Promise<Tab> => {
    const ws = new WebSocket(`ws://127.0.0.1:${served.server.port}/ws`);
    const tab: Tab = { ws, received: [], closed: null, reason: "" };
    ws.onmessage = (event) => tab.received.push(JSON.parse(String(event.data)));
    ws.onclose = (event) => {
      tab.closed = event.code;
      tab.reason = event.reason;
    };
    await until("challenge", () => got(tab, "challenge"));
    return tab;
  };
  /** Answer the challenge with `key` (and a pairing code). */
  const answer = async (tab: Tab, key: Key, pair?: string, board = served.room.hostPublicKey) => {
    const challenge = tab.received.find((m) => m.t === "challenge")!;
    if (challenge.t !== "challenge") throw new Error("no challenge");
    tab.ws.send(
      JSON.stringify({
        t: "auth",
        publicKey: key.publicKey,
        signature: await key.sign(ownerStatement(board, challenge.nonce)),
        ...(pair && { pair }),
      }),
    );
    await until("welcome or close", () => got(tab, "welcome") || tab.closed !== null);
    return tab;
  };
  return { ...served, dir, open, answer };
}

describe("pairing and the challenge", async () => {
  const { pairing, open, answer } = await start();
  const owner = await browserKey();

  test("a socket that hasn't authenticated gets nothing but the challenge", async () => {
    const tab = await open();
    tab.ws.send(JSON.stringify({ t: "file-open", path: "README.md" }));
    await until("closed", () => tab.closed !== null);
    expect(tab.closed).toBe(AUTH_REFUSED);
    expect(tab.received.map((m) => m.t)).toEqual(["challenge"]);
  });

  test("a stranger is refused while nobody is paired", async () => {
    const tab = await answer(await open(), await browserKey());
    expect(tab.closed).toBe(AUTH_REFUSED);
    expect(tab.reason).toContain("isn't paired");
  });

  test("the first browser with the printed code pairs and is welcomed", async () => {
    expect(pairing).toBeString();
    const tab = await answer(await open(), owner, pairing!);
    expect(got(tab, "welcome")).toBe(true);
    tab.ws.close();
  });

  test("the code is good once: another browser holding it is refused", async () => {
    const tab = await answer(await open(), await browserKey(), pairing!);
    expect(tab.closed).toBe(AUTH_REFUSED);
    expect(tab.reason).toContain("used up");
  });

  test("the owner comes back with its key alone", async () => {
    const tab = await answer(await open(), owner);
    expect(got(tab, "welcome")).toBe(true);
    tab.ws.close();
  });

  test("a signature for another board is refused", async () => {
    const tab = await answer(await open(), owner, undefined, "other-board");
    expect(tab.closed).toBe(AUTH_REFUSED);
  });

  test("a socket that's refused doesn't unseat the host", async () => {
    const host = await answer(await open(), owner);
    const stranger = await answer(await open(), await browserKey());
    expect(stranger.closed).toBe(AUTH_REFUSED);
    host.ws.send(JSON.stringify({ t: "file-open", path: "README.md" }));
    await until("host gets the file", () => got(host, "file"));
    expect(host.closed).toBeNull();
    host.ws.close();
  });
});

describe("host tabs", async () => {
  const { open, answer, pairing } = await start();
  const key = await browserKey();
  await answer(await open(), key, pairing!);
  /** A host tab: its WebSocket, what it received, and how it closed. */
  const connect = async () => answer(await open(), key);

  test("a newer tab takes over; the older one is told why", async () => {
    const older = await connect();
    const newer = await connect();
    await until("older closed", () => older.closed !== null);
    expect(older.closed).toBe(HOST_REPLACED);
    expect(newer.closed).toBeNull();

    newer.ws.send(JSON.stringify({ t: "file-open", path: "README.md" }));
    await until("newer gets the file", () => got(newer, "file"));
    newer.ws.close();
  });

  test("the older tab can take over again", async () => {
    const first = await connect();
    const second = await connect();
    await until("first replaced", () => first.closed === HOST_REPLACED);
    const again = await connect();
    await until("second replaced", () => second.closed === HOST_REPLACED);
    again.ws.send(JSON.stringify({ t: "file-open", path: "README.md" }));
    await until("the tab that took over gets the file", () => got(again, "file"));
    expect(got(second, "file")).toBe(false);
    again.ws.close();
  });
});

describe("members", async () => {
  const { open, answer, pairing } = await start();
  const host = await answer(await open(), await browserKey(), pairing!);
  const guest = await browserKey();
  const lists = () =>
    host.received.flatMap((m) =>
      m.t === "members" || m.t === "welcome" ? [m.members.map((x) => `${x.name}:${x.role}`)] : [],
    );

  test("the host tab admits, changes roles and removes; each change comes back", async () => {
    expect(lists()).toEqual([[]]);
    host.ws.send(
      JSON.stringify({ t: "member-admit", publicKey: guest.publicKey, name: "Ada", role: "edit" }),
    );
    await until("admitted", () => lists().length === 2);
    const welcome = host.received.find((m) => m.t === "members");
    const fingerprint = welcome?.t === "members" ? welcome.members[0]!.fingerprint : "";
    expect(fingerprint).toHaveLength(32);
    host.ws.send(JSON.stringify({ t: "member-role", fingerprint, role: "view" }));
    await until("role", () => lists().length === 3);
    host.ws.send(JSON.stringify({ t: "member-remove", fingerprint }));
    await until("removed", () => lists().length === 4);
    expect(lists()).toEqual([[], ["Ada:edit"], ["Ada:view"], []]);
  });

  test("a role that isn't one is refused", async () => {
    host.ws.send(
      JSON.stringify({ t: "member-admit", publicKey: guest.publicKey, name: "A", role: "trusted" }),
    );
    await until("error", () => got(host, "error"));
    expect(lists().at(-1)).toEqual([]);
  });
});

describe("resetting the invite link", async () => {
  const issuer = { name: "team", secret: "s3cret" };
  const relay: ServeRelay = { url: "wss://relay.example", via: "transport", issuer };
  const { open, answer, pairing, room: first, dir } = await start(relay);
  const owner = await browserKey();
  const host = await answer(await open(), owner, pairing!);
  const issuers = new Map([[issuer.name, issuer.secret]]);
  const roomOf = (token: string) => {
    const check = verifyRelayToken(token, issuers);
    return check.ok ? check.token.room : null;
  };
  const rooms = () => host.received.flatMap((m) => (m.t === "room" ? [m] : []));
  const saved = () => JSON.parse(readFileSync(join(dir, ".canvas", "room.json"), "utf8"));

  test("mints a new room id and key, keeps the host key, saves it and tells the host tab", async () => {
    host.ws.send(JSON.stringify({ t: "room-reset" }));
    await until("room", () => rooms().length === 1);
    const { room, relay } = rooms()[0]!;
    expect(room.roomId).not.toBe(first.roomId);
    expect(room.key).not.toBe(first.key);
    expect(room.hostPublicKey).toBe(first.hostPublicKey);
    expect(room.hostPrivateKey).toEqual(first.hostPrivateKey);
    expect(saved()).toEqual(room);
    // The relay room comes from the key: new tokens, for the new one.
    const welcome = host.received.find((m) => m.t === "welcome");
    if (welcome?.t !== "welcome") throw new Error("no welcome");
    expect(roomOf(welcome.relay!.guestToken)).toBe(await relayRoom(first.key));
    expect(roomOf(relay!.guestToken)).toBe(await relayRoom(room.key));
    expect(roomOf(relay!.hostToken)).toBe(await relayRoom(room.key));
  });

  test("the host link from before still opens it, in the new room", async () => {
    const tab = await answer(await open(), owner);
    const welcome = tab.received.find((m) => m.t === "welcome");
    expect(welcome?.t === "welcome" && welcome.room.roomId).toBe(saved().roomId);
    tab.ws.close();
  });

  test("removing a member resets it too, after the member list", async () => {
    const again = await answer(await open(), owner);
    const guest = await browserKey();
    again.ws.send(
      JSON.stringify({ t: "member-admit", publicKey: guest.publicKey, name: "Ada", role: "edit" }),
    );
    await until("admitted", () => again.received.filter((m) => m.t === "members").length === 1);
    const before = saved().roomId;
    const members = again.received.find((m) => m.t === "members");
    const fingerprint = members?.t === "members" ? members.members[0]!.fingerprint : "";
    again.ws.send(JSON.stringify({ t: "member-remove", fingerprint }));
    await until("room", () => got(again, "room"));
    const order = again.received.map((m) => m.t).filter((t) => t === "members" || t === "room");
    expect(order).toEqual(["members", "members", "room"]);
    expect(saved().roomId).not.toBe(before);
    // Nobody to remove: nothing changes.
    again.ws.send(JSON.stringify({ t: "member-remove", fingerprint }));
    await Bun.sleep(100);
    expect(again.received.filter((m) => m.t === "room")).toHaveLength(1);
    again.ws.close();
  });
});

describe("the runtime id (ADR 0013, decision 3)", async () => {
  const { open, answer, pairing, dir } = await start();
  const owner = await browserKey();
  const host = await answer(await open(), owner, pairing!);
  const saved = () => JSON.parse(readFileSync(join(dir, ".canvas", "runtime.json"), "utf8"));
  const runtimeOf = (tab: Tab) => {
    const welcome = tab.received.find((m) => m.t === "welcome");
    if (welcome?.t !== "welcome") throw new Error("no welcome");
    return welcome.runtime;
  };

  test("made the first time, 12 characters, saved and in the welcome", () => {
    expect(runtimeOf(host)).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(saved()).toEqual({ id: runtimeOf(host) });
  });

  test("the runtime's, not the room's: it survives resetting the invite link and a restart", async () => {
    const id = runtimeOf(host);
    host.ws.send(JSON.stringify({ t: "room-reset" }));
    await until("room", () => got(host, "room"));
    const again = await serve({ dir, port: 0, hostname: "127.0.0.1" });
    afterAll(() => void again.server.stop(true));
    expect(again.runtime).toBe(id);
    expect(saved()).toEqual({ id });
  });
});
