import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEY_ALGORITHM, SIGNATURE, ownerStatement, toBase64Url } from "../shared/identity";
import { AUTH_REFUSED, HOST_REPLACED, type ServerToClient } from "../shared/protocol";
import { serve } from "./server";

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

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "canvas-server-"));
  writeFileSync(join(dir, "README.md"), "# hi\n");
  const served = await serve({ dir, port: 0, hostname: "127.0.0.1" });
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
  const answer = async (tab: Tab, key: Key, pair?: string, roomId = served.room.roomId) => {
    const challenge = tab.received.find((m) => m.t === "challenge")!;
    if (challenge.t !== "challenge") throw new Error("no challenge");
    tab.ws.send(
      JSON.stringify({
        t: "auth",
        publicKey: key.publicKey,
        signature: await key.sign(ownerStatement(roomId, challenge.nonce)),
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

  test("a signature for another room is refused", async () => {
    const tab = await answer(await open(), owner, undefined, "other-room");
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
