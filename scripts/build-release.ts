#!/usr/bin/env bun
// Stages the npm package semantic-release publishes, under `dist/npm/canvas/`.
// The repo-root `package.json` stays `"private": true` permanently: only what
// this script generates ever reaches the registry, so publishing the workspace
// by accident is structurally impossible. Modelled on factory's.
//
// The package is `canvas serve` alone. It ships raw TypeScript and requires
// Bun at runtime; `bin/canvas.js` is the guard and launcher. The web app is
// not in it — the release workflow deploys that to ui.canvas.frebreco.de, and
// `src/server/web-url.ts` picks the build matching the version stamped here.
// So only `src/cli.ts`, `src/server/` and `src/shared/` are staged, with
// `skills/`, which every agent session loads (`src/server/agents.ts`), and the
// manifest carries only the dependencies they need, not React and friends.
//
// Usage: bun scripts/build-release.ts [version] [--smoke-test]
// `version` defaults to "0.0.0-dev" — enough to prove the package stages.

import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultWebUrl } from "../src/server/web-url";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST = join(REPO_ROOT, "dist", "npm");
const PKG = join(DIST, "canvas");
const NAME = "@frebreco/canvas";

// Matches the GitHub remote character for character — npm rejects an OIDC
// publish with an opaque error when the manifest's `repository.url` disagrees
// with the trusted publisher's repository.
const REPOSITORY_URL = "git+https://github.com/FreshlyBrewedCode/canvas.git";
const DESCRIPTION = "A multiplayer canvas for coding agents that run on your machine.";

/** What `canvas serve` is made of, relative to the repo root. */
const SOURCES = ["src/cli.ts", "src/server", "src/shared", "skills"];

/**
 * Packages the server needs without importing them: `agents.ts` resolves
 * claude-agent-acp's entry point and runs it as the `claude` agent.
 */
const RESOLVED_AT_RUNTIME = ["@agentclientprotocol/claude-agent-acp"];

const VERSION = process.argv[2] ?? "0.0.0-dev";
const SMOKE_TEST = process.argv.includes("--smoke-test");

function fail(message: string): never {
  console.error(`canvas: ${message}`);
  process.exit(1);
}

function run(cmd: string[], cwd: string = REPO_ROOT): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) fail(`\`${cmd.join(" ")}\` failed.`);
}

/** `@scope/name/sub/path` -> `@scope/name`, `name/sub` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * The root dependencies the staged sources need: every bare import, the
 * packages resolved at runtime, and the peers of those that the root pins too
 * (`@tanstack/ai-acp` expects `@tanstack/ai` beside it). An import the root
 * does not declare fails the build here rather than on a user's machine.
 */
async function runtimeDependencies(
  declared: Record<string, string>,
): Promise<Record<string, string>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const needed = new Set(RESOLVED_AT_RUNTIME);
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: join(PKG, "src") })) {
    // `scanImports` rejects the shebang `cli.ts` starts with.
    const code = (await Bun.file(join(PKG, "src", file)).text()).replace(/^#!.*/, "");
    for (const { path } of transpiler.scanImports(code)) {
      if (path.startsWith(".") || path.startsWith("node:") || path.startsWith("bun")) continue;
      if (builtinModules.includes(path)) continue;
      needed.add(packageOf(path));
    }
  }

  for (const name of [...needed]) {
    const manifest = (await Bun.file(
      join(REPO_ROOT, "node_modules", name, "package.json"),
    ).json()) as { peerDependencies?: Record<string, string> };
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (peer in declared) needed.add(peer);
    }
  }

  const dependencies: Record<string, string> = {};
  for (const name of [...needed].sort()) {
    const range = declared[name];
    if (range === undefined) fail(`the staged sources need "${name}", which package.json lacks.`);
    dependencies[name] = range;
  }
  return dependencies;
}

/**
 * Installs the staged package into `work` the way a registry install lays it
 * out: canvas as a *real directory* under `node_modules`, and beside it only
 * the dependencies its manifest declares. A symlink back into this repo would
 * let every lookup walk out of `dist/` into the repo's own `node_modules`, so
 * an undeclared dependency would still resolve and the test would pass.
 */
async function install(work: string, dependencies: Record<string, string>): Promise<string> {
  const modules = join(work, "node_modules");
  await mkdir(join(modules, "@frebreco"), { recursive: true });
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith("@")) await mkdir(join(modules, name.split("/")[0]!), { recursive: true });
    await symlink(join(REPO_ROOT, "node_modules", name), join(modules, name), "dir");
  }
  const installed = join(modules, "@frebreco", "canvas");
  await cp(PKG, installed, { recursive: true });
  return installed;
}

/**
 * Kills `child` if it hasn't printed what a smoke test waits for in time: that
 * ends its stdout, so the test fails with what it got instead of hanging.
 */
function killAfter(child: Bun.Subprocess, ms = 30_000): Timer {
  return setTimeout(() => child.kill(), ms);
}

/**
 * Runs `canvas serve` from the installed copy in a scratch project and checks
 * the host link it prints opens the web app of this release's channel.
 */
async function smokeTestServe(installed: string, work: string): Promise<void> {
  const project = join(work, "project");
  await mkdir(project);
  // The default is what is under test, so no override may leak in.
  const { CANVAS_WEB_URL: _, ...env } = process.env;
  const child = Bun.spawn({
    cmd: [process.execPath, join(installed, "bin", "canvas.js"), "serve", "--port", "0"],
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });

  async function inspect(): Promise<string | undefined> {
    let stdout = "";
    for await (const bytes of child.stdout as ReadableStream<Uint8Array>) {
      stdout += new TextDecoder().decode(bytes);
      if (stdout.includes("share the guest link")) break;
    }
    const link = /^\s*(https?:\/\/\S+\?room=\S+)$/m.exec(stdout)?.[1];
    if (link === undefined) return `\`canvas serve\` printed no host link.\n${stdout}`;
    const expected = `${defaultWebUrl(VERSION)}/?room=`;
    if (!link.startsWith(expected)) return `the host link opens ${link}, expected ${expected}…`;
    return undefined;
  }

  // Carried out of the try so the server is down before `fail` exits.
  let problem: string | undefined;
  const timeout = killAfter(child);
  try {
    problem = await inspect();
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
  if (problem !== undefined) fail(problem);
}

/**
 * Runs `canvas relay` from the installed copy and checks it answers `/health`:
 * it loads only its own code, so a missing file shows here, not in serve's test.
 */
async function smokeTestRelay(installed: string, work: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(installed, "bin", "canvas.js"),
      "relay",
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ],
    cwd: work,
    env: { ...process.env, CANVAS_RELAY_KEYS: "smoke:test" },
    stdout: "pipe",
    stderr: "inherit",
  });

  async function inspect(): Promise<string | undefined> {
    let stdout = "";
    for await (const bytes of child.stdout as ReadableStream<Uint8Array>) {
      stdout += new TextDecoder().decode(bytes);
      if (stdout.includes("limits:")) break;
    }
    const port = /canvas relay on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    if (port === undefined) return `\`canvas relay\` printed no address.\n${stdout}`;
    const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (!health?.ok) return `\`canvas relay\` doesn't answer /health on ${port}.`;
    return undefined;
  }

  let problem: string | undefined;
  const timeout = killAfter(child);
  try {
    problem = await inspect();
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
  if (problem !== undefined) fail(problem);
}

async function smokeTest(dependencies: Record<string, string>): Promise<void> {
  const node = Bun.spawnSync(["node", join(PKG, "bin", "canvas.js")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (node.exitCode === 0 || !node.stderr.toString().includes("requires Bun")) {
    fail("the launcher did not reject Node with the 'requires Bun' message.");
  }

  const work = await mkdtemp(join(tmpdir(), "canvas-smoke-"));
  try {
    const installed = await install(work, dependencies);
    run([process.execPath, join(installed, "bin", "canvas.js")], work);
    await smokeTestServe(installed, work);
    await smokeTestRelay(installed, work);
  } finally {
    await rm(work, { force: true, recursive: true });
  }
  console.log("canvas: smoke test passed.");
}

const rootManifest = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
  dependencies?: Record<string, string>;
};

console.log(`canvas: staging release ${VERSION}`);

await rm(DIST, { force: true, recursive: true });
await mkdir(join(PKG, "bin"), { recursive: true });

await cp(join(REPO_ROOT, "bin", "canvas.js"), join(PKG, "bin", "canvas.js"));
await chmod(join(PKG, "bin", "canvas.js"), 0o755);
for (const source of SOURCES) {
  await cp(join(REPO_ROOT, source), join(PKG, source), { recursive: true });
}
await cp(join(REPO_ROOT, "README.md"), join(PKG, "README.md"));
await cp(join(REPO_ROOT, "LICENSE"), join(PKG, "LICENSE"));

// Tests are development-only.
for await (const file of new Bun.Glob("**/*.test.ts").scan({ cwd: join(PKG, "src") })) {
  await rm(join(PKG, "src", file), { force: true });
}

if ((await readdir(join(PKG, "src"))).includes("web")) fail("the web app was staged.");

const dependencies = await runtimeDependencies(rootManifest.dependencies ?? {});

const manifest = {
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  license: "MIT",
  type: "module",
  bin: { canvas: "bin/canvas.js" },
  engines: { bun: ">=1.4.1" },
  homepage: "https://canvas.frebreco.de",
  repository: { type: "git", url: REPOSITORY_URL },
  files: ["bin", "src", "skills", "README.md", "LICENSE"],
  dependencies,
};

await Bun.write(join(PKG, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (SMOKE_TEST) await smokeTest(dependencies);

console.log(`canvas: staged ${NAME}@${VERSION} in ${PKG}`);
