import { expect, test } from "bun:test";
import { address, guestLink, readLink, type BoardLink } from "./link";

const link: BoardLink = {
  roomId: "r1",
  key: "k1",
  hostPublicKey: "pk1",
  host: { server: "ws://127.0.0.1:4418", pair: "secret" },
  relay: null,
};

test("a guest link carries the room but never the host's server or pairing code", () => {
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

test("a host link makes you the host, with or without its pairing code", () => {
  const read = (fragment: string) =>
    readLink(new URL(`https://ui.canvas.frebreco.de/?room=r1#${fragment}`) as unknown as Location);
  expect(read("k=k1&pk=pk1&server=ws%3A%2F%2F127.0.0.1%3A4418&pair=c0de")?.host).toEqual({
    server: "ws://127.0.0.1:4418",
    pair: "c0de",
  });
  expect(read("k=k1&pk=pk1&server=ws%3A%2F%2F127.0.0.1%3A4418")?.host).toEqual({
    server: "ws://127.0.0.1:4418",
    pair: null,
  });
  expect(read("k=k1&pk=pk1")?.host).toBeNull();
});

test("the address bar after a reset reads back as the link we are on, without the used code", () => {
  const read = (path: string) =>
    readLink(new URL(path, "https://ui.canvas.frebreco.de") as unknown as Location);
  const moved = { ...link, roomId: "r2", key: "k2" };
  expect(read(address(moved, "/next/"))).toEqual({
    ...moved,
    host: { server: "ws://127.0.0.1:4418", pair: null },
  });
  const guest: BoardLink = {
    ...moved,
    host: null,
    relay: { url: "wss://relay.corp", via: "signal", token: "g2" },
  };
  expect(address(guest, "/")).toStartWith("/?room=r2#k=k2&pk=pk1&relay=");
  expect(read(address(guest, "/"))).toEqual(guest);
});
