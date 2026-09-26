import { describe, expect, test } from "bun:test";

import { agentColor, resolveOccupants, type FocusState } from "./focus";

const person = (
  name: string,
  focus: FocusState["focus"],
  agents?: FocusState["agents"],
): FocusState => ({
  user: { name, color: "#f97316" },
  focus,
  ...(agents && { agents }),
});

const at = (
  frameId: string,
  since: number,
  scroll: { key: string; top: number } | null = null,
) => ({
  frameId,
  since,
  scroll,
});

describe("resolveOccupants", () => {
  test("a person who focuses a free frame occupies it", () => {
    const occupants = resolveOccupants([
      [1, person("Ada", at("f1", 10, { key: "thread", top: 40 }))],
    ]);
    expect(occupants.get("f1")).toMatchObject({
      key: "p:1",
      kind: "person",
      name: "Ada",
      scroll: { key: "thread", top: 40 },
    });
  });

  test("the earlier claim wins; a tie goes to the lower client id", () => {
    const later = resolveOccupants([
      [1, person("Ada", at("f1", 20))],
      [2, person("Karl", at("f1", 10))],
    ]);
    expect(later.get("f1")?.name).toBe("Karl");
    const tie = resolveOccupants([
      [7, person("Ada", at("f1", 10))],
      [3, person("Karl", at("f1", 10))],
    ]);
    expect(tie.get("f1")?.name).toBe("Karl");
  });

  test("an agent occupies the frame it works on, under its frame's title", () => {
    const occupants = resolveOccupants(
      [[1, person("Karl", null, [{ sessionId: "a1", frameId: "f2", since: 5 }])]],
      (id) => (id === "a1" ? "claude-1" : undefined),
    );
    expect(occupants.get("f2")).toMatchObject({
      key: "a:a1",
      kind: "agent",
      name: "claude-1",
      color: agentColor("a1"),
      scroll: null,
    });
  });

  test("a person beats an agent, even one that came first", () => {
    const occupants = resolveOccupants([
      [1, person("Karl", null, [{ sessionId: "a1", frameId: "f2", since: 5 }])],
      [2, person("Ada", at("f2", 50))],
    ]);
    expect(occupants.get("f2")?.name).toBe("Ada");
  });

  test("states without a user (not yet introduced) are skipped", () => {
    const occupants = resolveOccupants([[1, { focus: at("f1", 1) } as never]]);
    expect(occupants.size).toBe(0);
  });
});

describe("agentColor", () => {
  test("is stable per session", () => {
    expect(agentColor("abc")).toBe(agentColor("abc"));
    expect(agentColor("abc")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
