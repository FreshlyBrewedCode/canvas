import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_REPLACED, type ServerToClient } from "../shared/protocol";
import { serve } from "./server";

const until = async (what: string, test: () => boolean) => {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
};

describe("host tabs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-server-"));
  writeFileSync(join(dir, "README.md"), "# hi\n");
  const { server, room } = await serve({ dir, port: 0, hostname: "127.0.0.1" });
  afterAll(() => void server.stop(true));

  /** A host tab: its WebSocket, what it received, and how it closed. */
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${room.token}`);
    const tab = { ws, received: [] as ServerToClient[], closed: null as number | null };
    ws.onmessage = (event) => tab.received.push(JSON.parse(String(event.data)));
    ws.onclose = (event) => (tab.closed = event.code);
    await until("welcome", () => tab.received.some((m) => m.t === "welcome"));
    return tab;
  };
  const got = (tab: { received: ServerToClient[] }, t: ServerToClient["t"]) =>
    tab.received.some((m) => m.t === t);

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
