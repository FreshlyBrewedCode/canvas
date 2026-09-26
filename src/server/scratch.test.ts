import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SCRATCH_BYTES, Scratch } from "./scratch";

describe("Scratch", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-scratch-"));
  const changed: string[] = [];
  const scratch = new Scratch(dir, (path) => changed.push(path));

  test("creates files in .canvas/scratch, never taking a name twice", () => {
    expect(scratch.create("overview.md", "# one")).toBe("canvas:scratch/overview.md");
    expect(scratch.create("overview.md", "# two")).toBe("canvas:scratch/overview-2.md");
    expect(scratch.create("overview.md", "# three")).toBe("canvas:scratch/overview-3.md");
    expect(scratch.create("notes", "x")).toBe("canvas:scratch/notes");
    expect(scratch.create("notes", "y")).toBe("canvas:scratch/notes-2");
    expect(readFileSync(join(dir, ".canvas/scratch/overview-2.md"), "utf8")).toBe("# two");
    expect(changed).toContain("canvas:scratch/overview-3.md");
  });

  test("reads and overwrites by path", () => {
    expect(scratch.read("canvas:scratch/overview.md")).toEqual({ kind: "text", text: "# one" });
    scratch.write("canvas:scratch/overview.md", "# rewritten");
    expect(scratch.read("canvas:scratch/overview.md")).toEqual({
      kind: "text",
      text: "# rewritten",
    });
    expect(() => scratch.write("canvas:scratch/nope.md", "x")).toThrow("doesn't exist");
    expect(scratch.read("canvas:scratch/nope.md")).toEqual({ kind: "missing" });
  });

  test("names are one plain segment: nothing else in .canvas is reachable", () => {
    for (const name of ["../room.json", "a/b.md", ".hidden", "", "x\0y"])
      expect(() => scratch.create(name, "x")).toThrow("one plain segment");
    writeFileSync(join(dir, ".canvas/room.json"), "{}");
    expect(scratch.read("canvas:scratch/../room.json").kind).toBe("denied");
    expect(scratch.read("canvas:scratch/").kind).toBe("denied");
  });

  test("caps the size like shared files", () => {
    expect(() => scratch.create("big.txt", "x".repeat(MAX_SCRATCH_BYTES + 1))).toThrow("1 MiB");
  });

  test("lists and removes", () => {
    expect(scratch.list()).toContain("canvas:scratch/overview-2.md");
    scratch.remove("canvas:scratch/overview-2.md");
    expect(scratch.list()).not.toContain("canvas:scratch/overview-2.md");
    expect(scratch.create("overview.md", "again")).toBe("canvas:scratch/overview-2.md");
  });
});
