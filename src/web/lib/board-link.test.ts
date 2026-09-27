import { describe, expect, test } from "bun:test";

import { parseCodeRef, parseLink, readHash, Slugger, slug, withTarget } from "./board-link";

const board = (href: string, base = {}) => {
  const link = parseLink(href, base);
  return link?.kind === "board" ? link.target : link;
};

describe("parseLink", () => {
  test("frames, and places in them", () => {
    expect(board("#frame=abc")).toEqual({ frame: "abc" });
    expect(board("#frame=abc&lines=20-10&comment=c1")).toEqual({
      frame: "abc",
      lines: { start: 10, end: 20 },
      comment: "c1",
    });
    expect(board("#frame=abc&path=./src/a.ts&heading=setup")).toEqual({
      frame: "abc",
      path: "src/a.ts",
      heading: "setup",
    });
  });

  test("files as agents and GitHub write them, from the working dir", () => {
    expect(board("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(board("./src/a.ts#L42")).toEqual({ path: "src/a.ts", lines: { start: 42, end: 42 } });
    expect(board("src/a.ts#L10-L20")).toEqual({ path: "src/a.ts", lines: { start: 10, end: 20 } });
    expect(board("src/a.ts:10-20")).toEqual({ path: "src/a.ts", lines: { start: 10, end: 20 } });
    expect(board("src/a.ts:7:3")).toEqual({ path: "src/a.ts", lines: { start: 7, end: 7 } });
    expect(board("docs/my%20notes.md#Set-Up")).toEqual({
      path: "docs/my notes.md",
      heading: "set-up",
    });
    expect(board("canvas:scratch/overview.md:3")).toEqual({
      path: "canvas:scratch/overview.md",
      lines: { start: 3, end: 3 },
    });
  });

  test("absolute paths only under the working dir", () => {
    expect(board("/home/me/proj/src/a.ts:5", { cwd: "/home/me/proj/" })).toEqual({
      path: "src/a.ts",
      lines: { start: 5, end: 5 },
    });
    expect(board("/etc/passwd", { cwd: "/home/me/proj" })).toBeNull();
    expect(board("/home/me/proj-other/a.ts", { cwd: "/home/me/proj" })).toBeNull();
  });

  test("relative to the file it is in, never above the working dir", () => {
    expect(board("../src/a.ts", { file: "docs/guide.md" })).toEqual({ path: "src/a.ts" });
    expect(board("#install", { file: "docs/guide.md" })).toEqual({
      path: "docs/guide.md",
      heading: "install",
    });
    expect(board("../../x", { file: "docs/guide.md" })).toBeNull();
    // Nothing to scroll to outside a file.
    expect(board("#install")).toBeNull();
  });

  test("a scratch file's links stay among scratch files", () => {
    const base = { file: "canvas:scratch/index.html" };
    expect(board("page-2.html", base)).toEqual({ path: "canvas:scratch/page-2.html" });
    expect(board("../src/a.ts", base)).toBeNull();
    expect(board("sub/x.html", base)).toBeNull();
  });

  test("web links pass; other schemes go nowhere", () => {
    expect(parseLink("https://example.com/a#b")).toEqual({
      kind: "web",
      url: "https://example.com/a#b",
    });
    expect(parseLink("mailto:a@b.c")?.kind).toBe("web");
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc", "//evil.com", ""])
      expect(parseLink(href), href).toBeNull();
  });
});

describe("parseCodeRef", () => {
  test("paths with lines", () => {
    expect(parseCodeRef("src/a.ts:42")).toEqual({
      path: "src/a.ts",
      lines: { start: 42, end: 42 },
    });
    expect(parseCodeRef("package.json")).toEqual({ path: "package.json" });
    expect(parseCodeRef("/p/src/a.ts", { cwd: "/p" })).toEqual({ path: "src/a.ts" });
  });

  test("not code that only has a dot", () => {
    for (const code of ["npm run dev", "foo()", "a, b", "...", "https://x.y/z", "const", "x=1;"])
      expect(parseCodeRef(code), code).toBeNull();
  });
});

describe("the page fragment", () => {
  test("the board part is read beside the room's secrets and replaced without them", () => {
    expect(readHash("#k=K&pk=P&frame=abc&lines=3")).toEqual({
      frame: "abc",
      lines: { start: 3, end: 3 },
    });
    expect(readHash("#k=K&pk=P")).toBeNull();
    expect(withTarget("#k=K&pk=P&frame=old&lines=3", { frame: "new" })).toBe("k=K&pk=P&frame=new");
    expect(withTarget("k=K&frame=old", null)).toBe("k=K");
  });
});

describe("slug", () => {
  test("as GitHub makes them", () => {
    expect(slug("Getting Started!")).toBe("getting-started");
    expect(slug("ADR 0004: Previews")).toBe("adr-0004-previews");
    const slugger = new Slugger();
    expect(["Usage", "Usage", "Usage"].map((t) => slugger.slug(t))).toEqual([
      "usage",
      "usage-1",
      "usage-2",
    ]);
  });
});
