import { describe, expect, test } from "bun:test";

import { relayRoom } from "../shared/relay-room";
import { parseIssuer, parseIssuers, signRelayToken, verifyRelayToken } from "./relay-token";

const issuers = new Map([["team", "s3cret"]]);
const issuer = { name: "team", secret: "s3cret" };

describe("relay tokens", () => {
  test("a token names its issuer, room and role, and lasts 30 days", () => {
    const now = Date.UTC(2026, 8, 28);
    const token = signRelayToken(issuer, "room1", "guest", now);
    expect(verifyRelayToken(token, issuers, now)).toEqual({
      ok: true,
      token: { issuer: "team", room: "room1", role: "guest", expires: now / 1000 + 30 * 86_400 },
    });
    expect(verifyRelayToken(token, issuers, now + 31 * 86_400_000)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  test("changing any part breaks the signature", () => {
    const token = signRelayToken(issuer, "room1", "guest");
    const promoted = token.replace(".g.", ".h.");
    expect(verifyRelayToken(promoted, issuers)).toMatchObject({ reason: "bad signature" });
    const moved = token.replace("room1", "room2");
    expect(verifyRelayToken(moved, issuers)).toMatchObject({ reason: "bad signature" });
  });

  test("removing an issuer revokes its tokens", () => {
    const token = signRelayToken(issuer, "room1", "host");
    expect(verifyRelayToken(token, new Map())).toMatchObject({
      reason: "unknown issuer team",
    });
  });

  test("the relay room follows the board key, not the room id", async () => {
    expect(await relayRoom("k1")).toBe(await relayRoom("k1"));
    expect(await relayRoom("k1")).not.toBe(await relayRoom("k2"));
  });

  test("issuer keys are name:secret pairs", () => {
    expect(parseIssuers("karl:abc, team:d:e")).toEqual(
      new Map([
        ["karl", "abc"],
        ["team", "d:e"],
      ]),
    );
    expect(() => parseIssuers("nocolon")).toThrow();
    expect(() => parseIssuers("a.b:x")).toThrow();
    expect(parseIssuer("karl:abc")).toEqual({ name: "karl", secret: "abc" });
    expect(() => parseIssuer("a:1,b:2")).toThrow();
  });
});
