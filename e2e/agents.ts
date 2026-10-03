/**
 * Agent frames as tests use them. Unless `E2E_AGENTS` says otherwise, the
 * agents are recordings played back (`e2e/acp/cassette.ts`): what a test
 * types must be what was recorded, so prompts are constants of the test.
 */
import type { Page } from "@playwright/test";
import { add, frame } from "./board";

/** Real agents take their time; recordings don't. */
export const LIVE = (process.env.E2E_AGENTS ?? "replay") !== "replay";

/** Add an agent frame from the toolbar, pick its agent, and wait for it to come up. */
export async function newAgent(page: Page, kind: "claude" | "opencode"): Promise<string> {
  const id = await add(page, "Agent");
  await frame(page, id).locator(`[data-pick-agent=${kind}]`).click();
  await frame(page, id)
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: LIVE ? 60_000 : 15_000 });
  return id;
}

/** How many of a frame's turns are over: each has its footer. */
const turns = (page: Page, id: string) =>
  frame(page, id).locator("[data-turn-footer=done]").count();

/** Type a prompt into an agent frame's composer and send it: the turn it starts. */
export async function send(page: Page, id: string, text: string): Promise<number> {
  const turn = (await turns(page, id)) + 1;
  await frame(page, id).locator("[data-composer] .cm-content").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  return turn;
}

/**
 * Until the agent's `turn` (from `send`; else the next) is over, the host
 * allowing what it asks (`allow`).
 */
export async function idle(host: Page, id: string, { turn = 0, allow = true } = {}) {
  const until = turn || (await turns(host, id)) + 1;
  const deadline = Date.now() + (LIVE ? 300_000 : 30_000);
  while (Date.now() < deadline) {
    const asked = frame(host, id).locator("[data-permission-kind=allow_once]").first();
    // Not a pointer click: the card may be anywhere on the board, off screen.
    if (allow && (await asked.isVisible().catch(() => false)))
      await asked.evaluate((el: HTMLElement) => el.click()).catch(() => {});
    if ((await turns(host, id)) >= until) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the agent never went idle");
}

/** Send a prompt and wait for its turn to end. */
export async function ask(host: Page, id: string, text: string) {
  await idle(host, id, { turn: await send(host, id, text) });
}
