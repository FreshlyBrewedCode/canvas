import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileContent } from "../shared/protocol";
import { Files, MAX_FILE_BYTES } from "./files";
import { Scratch } from "./scratch";

const until = async (what: string, test: () => boolean) => {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
};

describe("Files", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-files-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".canvas"));
  writeFileSync(join(dir, ".canvas/room.json"), "{}");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  writeFileSync(join(dir, "huge.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  symlinkSync("/etc", join(dir, "etc-link"));

  const seen = new Map<string, FileContent[]>();
  const trees: Array<ReadonlyArray<string>> = [];
  const files = new Files(
    dir,
    (path, file) => seen.set(path, [...(seen.get(path) ?? []), file]),
    (paths) => trees.push(paths),
  );
  const latest = (path: string) => seen.get(path)?.at(-1);
  afterAll(() => files.stop());

  test("reads text, and says why it will not show the rest", () => {
    expect(files.read("README.md")).toEqual({ kind: "text", text: "# hi\n" });
    expect(files.read("docs/later.md")).toEqual({ kind: "missing" });
    expect(files.read("logo.png")).toMatchObject({ kind: "binary" });
    expect(files.read("huge.txt")).toMatchObject({ kind: "too-large" });
    for (const path of [".canvas/room.json", "etc-link/hostname", "../x", "/etc/passwd"])
      expect(files.read(path), path).toMatchObject({ kind: "denied" });
    expect(files.read("etc-link/hostname")).toMatchObject({
      reason: expect.stringContaining("symlink"),
    });
  });

  test("sends an open file now and on every change, replaced or not", async () => {
    files.open("README.md", "host");
    expect(latest("README.md")).toEqual({ kind: "text", text: "# hi\n" });
    writeFileSync(join(dir, "README.md"), "# edited\n");
    await until(
      "in-place write",
      () =>
        latest("README.md")?.kind === "text" &&
        (latest("README.md") as { text: string }).text === "# edited\n",
    );
    writeFileSync(join(dir, "README.tmp"), "# replaced\n");
    renameSync(join(dir, "README.tmp"), join(dir, "README.md"));
    await until(
      "atomic replace",
      () => (latest("README.md") as { text?: string }).text === "# replaced\n",
    );
  });

  test("a frame can wait for a file an agent has not written yet", async () => {
    files.open("docs/plan.md", "host");
    expect(latest("docs/plan.md")).toEqual({ kind: "missing" });
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/plan.md"), "# plan\n");
    await until("created", () => latest("docs/plan.md")?.kind === "text");
  });

  test("lists the shared set and follows it", async () => {
    files.watchTree();
    expect(trees.at(-1)).toContain("README.md");
    expect(trees.at(-1)).not.toContain(".canvas/room.json");
    writeFileSync(join(dir, "new.ts"), "export {};\n");
    await until("tree update", () => trees.at(-1)?.includes("new.ts") ?? false);
  });

  test("stops sending a file once every client closed it", async () => {
    files.open("new.ts", "a");
    files.open("new.ts", "b");
    files.close("new.ts", "a");
    const count = () => seen.get("new.ts")?.length ?? 0;
    writeFileSync(join(dir, "new.ts"), "export const a = 1;\n");
    await until("still open for b", () => count() === 2);
    files.drop("b");
    writeFileSync(join(dir, "new.ts"), "export const a = 2;\n");
    await Bun.sleep(400);
    expect(count()).toBe(2);
  });
});

describe("Files with scratch files", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-files-scratch-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# hi\n");
  const seen: Array<[string, FileContent]> = [];
  const trees: Array<ReadonlyArray<string>> = [];
  const scratch = new Scratch(dir, (path) => files.scratchChanged(path));
  const files = new Files(
    dir,
    (path, file) => seen.push([path, file]),
    (paths) => trees.push(paths),
    scratch,
  );
  afterAll(() => files.stop());

  test("reads them by their board path, lists them and sends them live", () => {
    files.watchTree();
    expect(trees.at(-1)).toEqual(["README.md"]);
    files.open("canvas:scratch/flow.html", "host");
    expect(seen.at(-1)).toEqual(["canvas:scratch/flow.html", { kind: "missing" }]);

    const path = scratch.create("flow.html", "<p>1</p>");
    expect(path).toBe("canvas:scratch/flow.html");
    expect(seen.at(-1)).toEqual([path, { kind: "text", text: "<p>1</p>" }]);
    expect(trees.at(-1)).toEqual(["README.md", "canvas:scratch/flow.html"]);

    scratch.write(path, "<p>2</p>");
    expect(seen.at(-1)).toEqual([path, { kind: "text", text: "<p>2</p>" }]);
    // Still not reachable as a plain path: the shared set refuses .canvas.
    expect(files.read(".canvas/scratch/flow.html").kind).toBe("denied");
  });
});
