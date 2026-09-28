import { expect, test } from "bun:test";
import { guestLink, readLink, type BoardLink } from "./link";

const link: BoardLink = {
  roomId: "r1",
  key: "k1",
  hostPublicKey: "pk1",
  host: { server: "ws://127.0.0.1:4418", token: "secret" },
  relay: null,
};

test("a guest link carries the room but never the host's server or token", () => {
  expect(guestLink(link, "https://ui.canvas.frebreco.de/")).toBe(
    "https://ui.canvas.frebreco.de/?room=r1#k=k1&pk=pk1",
  );
});

test("a guest link stays on the build its host is on", () => {
  expect(guestLink(link, "https://ui.canvas.frebreco.de/next/")).toBe(
    "https://ui.canvas.frebreco.de/next/?room=r1#k=k1&pk=pk1",
  );
});

test("a guest link names the board's relay and its guest token", () => {
  const relay = { url: "wss://relay.corp", via: "transport" as const, token: "guest-t" };
  expect(guestLink(link, "https://ui.canvas.frebreco.de/", relay)).toBe(
    "https://ui.canvas.frebreco.de/?room=r1#k=k1&pk=pk1&relay=wss%3A%2F%2Frelay.corp&via=transport&rt=guest-t",
  );
});

test("a guest link from a relay link keeps its relay", () => {
  const url = new URL(
    "https://ui.canvas.frebreco.de/?room=r1#k=k1&pk=pk1&relay=wss%3A%2F%2Frelay.corp&via=signal&rt=g",
  );
  expect(readLink(url as unknown as Location)?.relay).toEqual({
    url: "wss://relay.corp",
    via: "signal",
    token: "g",
  });
});
