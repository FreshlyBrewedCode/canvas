/**
 * The fixtures every e2e test builds on: a `canvas serve` of its own on a fresh
 * copy of a fixture project (`e2e/projects/<name>`), the host's tab on it and,
 * when a test asks for one, a guest's, joined through the guest link the host
 * copies — as people share it.
 *
 *   test.use({ project: "docs" })   another fixture project
 */
import {
  test as base,
  expect as baseExpect,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E } from "./env";

/** Playwright's `expect`, and positions on screen give or take a pixel or two. */
export const expect = baseExpect.extend({
  toBeNear(received: number, expected: number, within: number = 2) {
    const pass = Math.abs(received - expected) < within;
    return {
      pass,
      message: () =>
        `expected ${received} ${pass ? "not " : ""}to be within ${within} of ${expected}`,
    };
  },
});

const ROOT = resolve(import.meta.dirname, "..");

export interface Serve {
  /** The project `canvas serve` serves: a copy, the test's own. */
  readonly dir: string;
  /** The host's link. */
  readonly link: string;
  /** Stop and start it again on the same port and board, as a host restarting it. */
  restart(): Promise<void>;
}

interface Options {
  /** The fixture project, a folder of `e2e/projects/`. */
  project: string;
  /** Environment variables for `canvas serve`. */
  serveEnv: Record<string, string>;
}

interface Fixtures {
  serve: Serve;
  host: Page;
  guest: Page;
}

export const test = base.extend<Options & Fixtures>({
  project: ["basic", { option: true }],
  serveEnv: [{}, { option: true }],

  serve: async ({ project, serveEnv }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-e2e-"));
    cpSync(join(ROOT, "e2e/projects", project), dir, { recursive: true });
    // A repo, as projects are: the shared set follows git (ADR 0002).
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
      ["-c", "user.name=e2e", "-c", "user.email=e2e@canvas", "commit", "-qm", "fixture"],
    ])
      spawnSync("git", args, { cwd: dir });

    let port = 0;
    let child: ChildProcess;
    let link = "";
    const start = async () => {
      child = spawn(
        "bun",
        [
          "src/cli.ts",
          "serve",
          ...["--dir", dir, "--port", String(port), "--web-url", E2E.webUrl],
          ...["--relay", E2E.relayUrl, "--relay-key", E2E.relayKey],
        ],
        { cwd: ROOT, env: { ...process.env, ...serveEnv }, stdio: ["ignore", "pipe", "pipe"] },
      );
      log(child, "serve", testInfo);
      link = await new Promise<string>((done, fail) => {
        let out = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          out += chunk;
          const found = /http:\/\/\S+\?room=\S+/.exec(out);
          if (found) done(found[0]);
        });
        child.on("exit", (code) => fail(new Error(`canvas serve exited (${code}): ${out}`)));
      });
      port = Number(new URL(new URLSearchParams(new URL(link).hash.slice(1)).get("server")!).port);
    };
    await start();
    await use({
      dir,
      get link() {
        return link;
      },
      async restart() {
        await stop(child);
        await start();
      },
    });
    await stop(child!);
    rmSync(dir, { recursive: true, force: true });
  },

  // A fresh browser each test: the link's pairing code makes it the board's owner (ADR 0011).
  host: async ({ browser, serve }, use, testInfo) => {
    const page = await open(browser, serve.link, "Karl", "#f97316", testInfo);
    await expect(page.getByText("connected to canvas serve")).toBeVisible({ timeout: 15_000 });
    await use(page);
    await page.context().close();
  },

  guest: async ({ browser, host }, use, testInfo) => {
    await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await host.getByRole("button", { name: "Copy guest link" }).click();
    const link = await host.evaluate(() => navigator.clipboard.readText());
    const page = await open(browser, link, "Ada", "#3b82f6", testInfo);
    await letIn(host, page, "Ada");
    await use(page);
    await page.context().close();
  },
});

/**
 * The guest link is an invite (ADR 0011): a browser the host doesn't know
 * knocks, and the host lets it in, to edit or to view; a member's browser
 * comes straight in.
 */
export async function letIn(host: Page, page: Page, name: string, role: "edit" | "view" = "edit") {
  const knock = host.locator(`[data-knock="${name}"]`).first();
  const board = page.locator("[data-board]");
  // Two pages: until either the knock or the board shows.
  await expect
    .poll(async () => (await knock.isVisible()) || (await board.isVisible()), { timeout: 30_000 })
    .toBe(true);
  if (await knock.isVisible())
    await knock
      .getByRole("button", { name: role === "edit" ? "Admit to edit" : "Admit to view" })
      .click();
  await expect(board).toBeVisible({ timeout: 30_000 });
}

/** A person's tab: their own context, so their own storage and identity. */
export async function open(
  browser: Browser,
  url: string,
  name: string,
  color: string,
  testInfo: TestInfo,
): Promise<Page> {
  const context = await browser.newContext();
  // Runs in every frame; sandboxed ones (HTML previews) have no storage.
  await context.addInitScript(
    ([n, c]) => {
      try {
        localStorage.setItem("canvas.identity", JSON.stringify({ name: n, color: c }));
      } catch {}
    },
    [name, color],
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  context.on("close", () => {
    if (errors.length) void testInfo.attach(`${name} console errors`, { body: errors.join("\n") });
  });
  await page.goto(url);
  return page;
}

function log(child: ChildProcess, name: string, testInfo: TestInfo) {
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stderr!.on("data", (chunk) => (out += chunk));
  child.on("exit", () => {
    if (out) void testInfo.attach(`${name} output`, { body: out }).catch(() => undefined);
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await exited;
}
