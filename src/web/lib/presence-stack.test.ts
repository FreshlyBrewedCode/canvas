import { describe, expect, test } from "bun:test";

import { stack } from "./presence-stack";

const peers = ["a", "b", "c", "d", "e", "f", "g"];
const none = () => false;

describe("stack", () => {
  test("as many as fit: everyone, nothing under +n", () => {
    expect(stack(peers.slice(0, 5), none)).toEqual({ shown: peers.slice(0, 5), rest: [] });
    expect(stack([], none)).toEqual({ shown: [], rest: [] });
  });

  test("more: the first ones, +n taking the last place", () => {
    expect(stack(peers, none)).toEqual({
      shown: ["a", "b", "c", "d"],
      rest: ["e", "f", "g"],
    });
  });

  test("whoever we follow keeps an avatar, in the last place", () => {
    expect(stack(peers, (p) => p === "f")).toEqual({
      shown: ["a", "b", "c", "f"],
      rest: ["d", "e", "g"],
    });
    expect(stack(peers, (p) => p === "b").shown, "already shown: as it is").toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
