import { describe, expect, test } from "bun:test";

import { addressKey, isRuntimeId, reach, sameAddress } from "./address";

const OWN = "Rt0wn-runtime";

describe("an address and the board's own runtime", () => {
  test("absent is the own runtime and its working dir", () => {
    expect(reach({}, OWN)).toBe("own");
    expect(reach({ runtime: undefined, root: undefined }, OWN)).toBe("own");
  });

  test("the own runtime's id written out names the same runtime", () => {
    expect(reach({ runtime: OWN }, OWN)).toBe("own");
    expect(sameAddress({ runtime: OWN }, {}, OWN)).toBe(true);
    expect(addressKey({ runtime: OWN }, OWN, "a.ts")).toBe(addressKey({}, OWN, "a.ts"));
  });

  test("another runtime, or a root, is elsewhere", () => {
    expect(reach({ runtime: "other" }, OWN)).toBe("elsewhere");
    // There is one root today, the working dir: any root named is another.
    expect(reach({ root: "worktree-1" }, OWN)).toBe("elsewhere");
    expect(reach({ runtime: OWN, root: "worktree-1" }, OWN)).toBe("elsewhere");
    expect(sameAddress({ runtime: "other" }, {}, OWN)).toBe(false);
    expect(sameAddress({ runtime: "other" }, { runtime: "other" }, OWN)).toBe(true);
    expect(sameAddress({ root: "r" }, {}, OWN)).toBe(false);
  });

  test("not knowing the own runtime yet, only absent is own", () => {
    expect(reach({}, null)).toBe("own");
    expect(reach({ runtime: OWN }, null)).toBe("elsewhere");
  });

  test("values that are no id (guests write the doc) name nothing reachable", () => {
    for (const runtime of [42, "", "a b", "../x", "x".repeat(65), null, {}])
      expect(reach({ runtime }, OWN), JSON.stringify(runtime)).toBe("nowhere");
    for (const root of [7, "", "a/b", null])
      expect(reach({ root }, OWN), JSON.stringify(root)).toBe("nowhere");
    expect(isRuntimeId("Ab_9-x")).toBe(true);
    expect(isRuntimeId("a.b")).toBe(false);
  });

  test("things of the own runtime are keyed by their bare id; others' apart", () => {
    expect(addressKey({}, OWN, "s1")).toBe("s1");
    const other = addressKey({ runtime: "other" }, OWN, "s1");
    expect(other).not.toBe("s1");
    expect(addressKey({ runtime: "third" }, OWN, "s1")).not.toBe(other);
    expect(addressKey({ runtime: "other", root: "r" }, OWN, "s1")).not.toBe(other);
  });
});
