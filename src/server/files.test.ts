import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Files } from "./files";

describe("Files", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-files-"));
  const files = new Files(dir, () => {});

  test("writes inside the working dir", () => {
    files.write("docs/a.md", "# a\n");
    expect(readFileSync(join(dir, "docs/a.md"), "utf8")).toBe("# a\n");
  });

  test("refuses paths that leave the working dir", () => {
    expect(() => files.write("../escape.md", "x")).toThrow(/escapes/);
    expect(() => files.write("/etc/passwd", "x")).toThrow(/escapes/);
    expect(() => files.watch("docs/../../x.md")).toThrow(/escapes/);
  });
});
