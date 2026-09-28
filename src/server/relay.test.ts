import { afterAll, describe, expect, test } from "bun:test";

import {
  RELAY_RATE_LIMITED,
  RELAY_REFUSED,
  type RelayServerControl,
} from "../shared/relay-protocol";
import { Budget, startRelay } from "./relay";
import { DEFAULT_LIMITS, relayConfig } from "./relay-config";
import { signRelayToken } from "./relay-token";

const issuer = { name: "team", secret: "s3cret" };
const relay = startRelay({
  port: 0,
  hostname: "127.0.0.1",
  issuers: new Map([
    ["team", "s3cret"],
    ["other", "x"],
  ]),
  limits: { connectionsPerIssuer: 2, messagesPerSecond: 5 },
  joinTimeoutMs: 200,
});
afterAll(() => relay.stop(true));
const base = `127.0.0.1:${relay.port}`;

/** A raw `/transport` connection: what it was told, and how it closed. */
function connect() {
  const ws = new WebSocket(`ws://${base}/transport`);
  const told: RelayServerControl[] = [];
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") told.push(JSON.parse(e.data) as RelayServerControl);
  });
  const open = new Promise((resolve) => ws.addEventListener("open", resolve));
  const join = async (
    room: string,
    peer: string,
    token = signRelayToken(issuer, room, "guest"),
  ) => {
    await open;
    ws.send(JSON.stringify({ t: "join", room, peer, token }));
  };
  return { ws, told, closed, join };
}

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("canvas relay", () => {
  test("an issuer's connections are capped, and freed when they close", async () => {
    const a = connect();
    const b = connect();
    await a.join("r1", "a");
    await b.join("r2", "b");
    await until(() => a.told.length > 0 && b.told.length > 0);
    const c = connect();
    await c.join("r3", "c");
    expect(await c.closed).toBe(RELAY_REFUSED);
    expect(c.told).toEqual([{ t: "error", message: "issuer team is at its connection limit" }]);

    a.ws.close();
    await a.closed;
    const d = connect();
    await d.join("r3", "d");
    await until(() => d.told.length > 0);
    expect(d.told[0]).toEqual({ t: "joined", peers: [] });
    b.ws.close();
    d.ws.close();
    await Promise.all([b.closed, d.closed]);
  });

  test("a connection over its message rate is closed", async () => {
    const a = connect();
    await a.join("r4", "a");
    await until(() => a.told.length > 0);
    // 5 a second, bursts of 4 seconds' worth: the 21st in a row is over.
    for (let i = 0; i < 25; i++) a.ws.send(new Uint8Array(8));
    expect(await a.closed).toBe(RELAY_RATE_LIMITED);
  });

  test("a connection that doesn't join in time is closed", async () => {
    const idle = connect();
    expect(await idle.closed).toBe(RELAY_REFUSED);
    expect(idle.told).toEqual([{ t: "error", message: "no join in time" }]);
  });

  test("signalling wants a token too", async () => {
    const refused = await fetch(`http://${base}/signal`, { headers: { upgrade: "websocket" } });
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("malformed token");
  });

  test("health counts, and names no rooms or issuers", async () => {
    const health = (await (await fetch(`http://${base}/health`)).json()) as Record<string, unknown>;
    expect(Object.keys(health).sort()).toEqual(["connections", "ok", "peers", "rooms"]);
  });
});

describe("Budget", () => {
  test("lets a burst through, then refills with time", () => {
    const budget = new Budget(10, 1000, 1);
    for (let i = 0; i < 10; i++) expect(budget.spend(10, 0)).toBe(true);
    expect(budget.spend(10, 0)).toBe(false);
    expect(budget.spend(10, 200)).toBe(true);
  });

  test("lets one message larger than the burst through on a full bucket", () => {
    const budget = new Budget(10, 1000, 1);
    expect(budget.spend(5000, 0)).toBe(true);
    expect(budget.spend(10, 0)).toBe(false);
  });
});

describe("relayConfig", () => {
  test("reads the environment; flags win", () => {
    const config = relayConfig(
      {
        CANVAS_RELAY_KEYS: "a:1,b:2",
        CANVAS_RELAY_PORT: "5000",
        CANVAS_RELAY_MAX_MESSAGE_MB: "8",
        CANVAS_RELAY_RATE: "100",
      },
      { port: "6000" },
    );
    expect(config.port).toBe(6000);
    expect(config.hostname).toBe("0.0.0.0");
    expect([...config.issuers.keys()]).toEqual(["a", "b"]);
    expect(config.limits.maxMessage).toBe(8 * 1024 * 1024);
    expect(config.limits.messagesPerSecond).toBe(100);
    expect(config.tls).toBeUndefined();
  });

  test("without settings, the defaults", () => {
    expect(relayConfig({ CANVAS_RELAY_KEYS: "a:1" })).toEqual({
      port: 4419,
      hostname: "0.0.0.0",
      issuers: new Map([["a", "1"]]),
      limits: DEFAULT_LIMITS,
    });
  });

  test("refuses no keys, half a TLS pair and nonsense limits", () => {
    expect(() => relayConfig({})).toThrow("CANVAS_RELAY_KEYS");
    expect(() => relayConfig({ CANVAS_RELAY_KEYS: "a:1", CANVAS_RELAY_TLS_CERT: "c" })).toThrow(
      "TLS",
    );
    expect(() => relayConfig({ CANVAS_RELAY_KEYS: "a:1", CANVAS_RELAY_RATE: "-1" })).toThrow(
      "CANVAS_RELAY_RATE",
    );
  });
});
