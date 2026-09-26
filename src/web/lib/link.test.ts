import { expect, test } from "bun:test";
import { guestLink, type BoardLink } from "./link";

const link: BoardLink = {
  roomId: "r1",
  key: "k1",
  hostPublicKey: "pk1",
  host: { server: "ws://127.0.0.1:4418", token: "secret" },
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
