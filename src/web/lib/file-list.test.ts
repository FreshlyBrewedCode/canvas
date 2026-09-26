import { describe, expect, test } from "bun:test";

import { checkDisplays, displayPath, entryFor, listOrder } from "./file-list";

describe("displayPath", () => {
  test("takes any folders and names, trimmed of leading slashes", () => {
    expect(displayPath("Auth/1. session.ts")).toBe("Auth/1. session.ts");
    expect(displayPath(" ./overview.md")).toBe("overview.md");
    expect(displayPath("/a/b.md")).toBe("a/b.md");
  });

  test("refuses empty segments and . or ..", () => {
    for (const bad of ["", " ", "a//b", "a/", "../x", "a/./b", 3])
      expect(() => displayPath(bad), String(bad)).toThrow();
  });
});

describe("checkDisplays", () => {
  test("display paths are unique, and none is a folder of another", () => {
    expect(() => checkDisplays(["a.md", "Auth/a.md"])).not.toThrow();
    expect(() => checkDisplays(["a.md", "a.md"])).toThrow("twice");
    expect(() => checkDisplays(["Auth", "Auth/a.md"])).toThrow("a file and a folder");
  });
});

describe("listOrder", () => {
  /** Sort display paths the way the tree does: as files and their folders. */
  const sorted = (displays: string[]) => {
    const order = listOrder(displays);
    const entries = new Map<string, string[]>();
    for (const display of displays) {
      const parts = display.split("/");
      parts.forEach((_, i) => {
        const path = parts.slice(0, i + 1).join("/");
        entries.set(path, parts.slice(0, i + 1));
      });
    }
    return [...entries.values()]
      .sort((a, b) => order({ segments: a }, { segments: b }))
      .map((segments) => segments.join("/"));
  };

  test("keeps the agent's order; a folder sorts where its first entry is", () => {
    expect(
      sorted([
        "overview.md",
        "Auth/session.ts",
        "Routes/login.ts",
        "Auth/password.ts",
        "flow.html",
      ]),
    ).toEqual([
      "overview.md",
      "Auth",
      "Auth/session.ts",
      "Auth/password.ts",
      "Routes",
      "Routes/login.ts",
      "flow.html",
    ]);
  });

  test("a flat list stays in order, not alphabetical", () => {
    expect(sorted(["z.ts", "a.ts", "m.ts"])).toEqual(["z.ts", "a.ts", "m.ts"]);
  });
});

describe("entryFor", () => {
  const list = [
    { display: "a (setup)", path: "src/a.ts", lines: { start: 1, end: 5 } },
    { display: "a (use)", path: "src/a.ts", lines: { start: 40, end: 50 } },
    { display: "b", path: "canvas:scratch/b.md" },
  ];

  test("finds the entry by path and lines, else by path", () => {
    expect(entryFor(list, "src/a.ts", { start: 40, end: 50 })?.display).toBe("a (use)");
    expect(entryFor(list, "src/a.ts", { start: 7, end: 7 })?.display).toBe("a (setup)");
    expect(entryFor(list, "canvas:scratch/b.md", null)?.display).toBe("b");
    expect(entryFor(list, "src/c.ts", null)).toBeUndefined();
  });
});
