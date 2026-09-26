import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refusal, SharedSet } from "./shared-set";

function project(git: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "canvas-shared-"));
  const write = (path: string, content = "x") => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  if (git) Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  write(".gitignore", "node_modules/\ndist/\n*.log\n");
  write("src/app.ts");
  write("README.md");
  write(".env");
  write(".env.example");
  write(".canvas/room.json", '{"token":"secret"}');
  write("dist/bundle.js");
  write("debug.log");
  write("node_modules/pkg/index.js");
  write(".github/workflows/ci.yml");
  symlinkSync("/etc", join(dir, "etc-link"));
  symlinkSync(".env", join(dir, "env-link.md"));
  symlinkSync("src/app.ts", join(dir, "app-link.ts"));
  symlinkSync("/nonexistent/target", join(dir, "dangling.md"));
  return dir;
}

describe("refusal", () => {
  test("never shares canvas state, git internals or secret-looking files", () => {
    expect(refusal(".canvas/room.json")).not.toBeNull();
    expect(refusal("sub/.git/config")).not.toBeNull();
    expect(refusal(".env")).not.toBeNull();
    expect(refusal("apps/web/.env.local")).not.toBeNull();
    expect(refusal("certs/server.key")).not.toBeNull();
    expect(refusal("id_ed25519")).not.toBeNull();
    expect(refusal(".env.example")).toBeNull();
    expect(refusal("src/keyboard.ts")).toBeNull();
    expect(refusal(".github/workflows/ci.yml")).toBeNull();
  });
});

describe("SharedSet in a git repo", () => {
  const shared = new SharedSet(project(true));

  test("resolves shared files, existing or not", () => {
    expect(shared.resolve("src/app.ts")).toBe(join(shared.dir, "src/app.ts"));
    expect(shared.resolve("docs/not-yet.md")).toBe(join(shared.dir, "docs/not-yet.md"));
    expect(shared.resolve("app-link.ts")).toBe(join(shared.dir, "app-link.ts"));
  });

  test("refuses everything outside the set", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../escape.md",
      "src/../../escape.md",
      ".canvas/room.json",
      ".git/config",
      ".env",
      "dist/bundle.js",
      "debug.log",
      "node_modules/pkg/index.js",
      "etc-link/hostname",
      "env-link.md",
      "dangling.md",
    ])
      expect(() => shared.resolve(path), path).toThrow();
  });

  test("lists files git does not ignore, minus secrets and links out of the set", () => {
    const expected = [
      ".env.example",
      ".github/workflows/ci.yml",
      ".gitignore",
      "README.md",
      "app-link.ts",
      "src/app.ts",
    ];
    expect(shared.list()).toEqual(expected);
    // Tracked links are told apart by git, untracked ones by lstat.
    Bun.spawnSync(["git", "add", "-A"], { cwd: shared.dir });
    expect(shared.list()).toEqual(expected);
  });
});

describe("SharedSet outside git", () => {
  const shared = new SharedSet(project(false));

  test("skips dependency and dot dirs instead of gitignore", () => {
    expect(shared.git).toBe(false);
    expect(() => shared.resolve("node_modules/pkg/index.js")).toThrow();
    expect(() => shared.resolve(".github/workflows/ci.yml")).toThrow();
    expect(shared.resolve("dist/bundle.js")).toBe(join(shared.dir, "dist/bundle.js"));
    expect(shared.list()).toContain("src/app.ts");
    expect(shared.list()).not.toContain("node_modules/pkg/index.js");
    expect(shared.list()).not.toContain(".env");
  });
});
