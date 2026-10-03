// End-to-end tests: a host and a guest in separate browser contexts against the
// Vite dev server, each test with its own `canvas serve` on a fresh copy of a
// fixture project (`e2e/fixtures.ts`). Peers reach each other through a local
// `canvas relay`, so nothing depends on public Nostr relays or WebRTC.
//
//   bun run e2e                       everything
//   bun run e2e -g "Shift \+ X"       one test, by title
//   bun run e2e --ui                  Playwright's UI mode
import { defineConfig } from "@playwright/test";
import { E2E } from "./env";

export default defineConfig({
  testDir: "tests",
  outputDir: "../test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : process.env.CI ? 3 : 4,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  use: {
    baseURL: E2E.webUrl,
    viewport: { width: 1400, height: 900 },
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bunx vite",
      cwd: "..",
      env: { PORT: String(E2E.webPort) },
      url: E2E.webUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `bun src/cli.ts relay --port ${E2E.relayPort} --host 127.0.0.1`,
      cwd: "..",
      env: { CANVAS_RELAY_KEYS: E2E.relayKey },
      url: `http://127.0.0.1:${E2E.relayPort}/health`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
