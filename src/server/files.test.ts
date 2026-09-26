import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Files } from "./files";

describe("Files", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-files-"));
  mkdirSync(join(dir, ".canvas"));
  writeFileSync(join(dir, ".canvas/room.json"), "{}");
  symlinkSync("/etc", join(dir, "etc-link"));
  const files = new Files(dir, () => {});

  test("writes inside the working dir", () => {
    files.write("docs/a.md", "# a\n");
    expect(readFileSync(join(dir, "docs/a.md"), "utf8")).toBe("# a\n");
  });

  test("refuses paths outside the shared set", () => {
    expect(() => files.write("../escape.md", "x")).toThrow(/outside/);
    expect(() => files.write("/etc/passwd", "x")).toThrow(/not a file path/);
    expect(() => files.watch("docs/../../x.md")).toThrow(/outside/);
    expect(() => files.watch(".canvas/room.json")).toThrow(/not shared/);
    expect(() => files.watch("etc-link/hostname")).toThrow(/links outside/);
  });
});
