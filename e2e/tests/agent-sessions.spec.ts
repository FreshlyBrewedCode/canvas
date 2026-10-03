// Conversations of an agent frame (ADR 0012, finding 21): a new one in the
// same frame, and back to one before — for everyone, as the frame shows it.
// The agent is opencode, replayed from its recordings (`e2e/acp/cassette.ts`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { idle, newAgent, send, sessions } from "../agents";
import { at, clear, frame } from "../board";
import { expect, test } from "../fixtures";
import { setRole } from "../members";

const REMEMBER = "Remember the word marmalade. Reply with just OK.";
const RECALL = "Which word did I ask you to remember? Reply with just the word.";

const composer = (page: Page, id: string) => frame(page, id).locator("[data-composer] .cm-content");
const draftOf = (page: Page, id: string) =>
  page.evaluate((id) => (window as any).room.doc.getText(`prompt:${id}`).toString(), id);
const prompts = (page: Page, id: string) => frame(page, id).locator("[data-sel-key$=':prompt']");
const menu = (page: Page) => page.locator("[data-conversations-popover]");
/** The session a frame shows, as the doc has it (its own id's without one). */
const shown = async (page: Page, id: string): Promise<string> => (await at(page, id)).session ?? id;

// The turn in real time (up to a second between messages): it runs long enough to watch.
test.use({ serveEnv: { CANVAS_REPLAY_GAP_MS: "1000" } });

test("new conversations in a frame, and back", async ({ host, guest, serve }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  const open = async (page: Page) => {
    await frame(page, id).locator("[data-conversations]").click();
    await expect(menu(page)).toBeVisible();
  };
  const logs = () => readdirSync(join(serve.dir, ".canvas/sessions"));
  const first = await shown(host, id);

  await test.step("while a turn runs, the menu doesn't switch", async () => {
    const turn = await send(host, id, REMEMBER);
    await expect(frame(host, id).locator("[data-turn-footer=running]")).toBeVisible({
      timeout: 30_000,
    });
    await open(host);
    await expect(menu(host).locator("[data-new-conversation]")).toBeDisabled();
    await expect(menu(host)).toContainText("Stop the agent to switch.");
    await host.keyboard.press("Escape");
    await idle(host, id, { turn });
  });

  const chip = frame(host, id).locator("[data-agent-settings]");
  const settings = await chip.innerText();

  await test.step("a new conversation: an empty thread, the same settings, the draft kept", async () => {
    await composer(host, id).click();
    await host.keyboard.type("not sent");
    await open(host);
    await menu(host).locator("[data-new-conversation]").click();
    await expect(prompts(host, id), "an empty thread").toHaveCount(0);
    await expect(prompts(guest, id), "…for the guest too").toHaveCount(0);
    await expect(chip, "the settings carry over").toHaveText(settings);
    expect(await draftOf(host, id), "the frame's draft stays").toBe("not sent");
    await host.keyboard.press("Control+a");
    await host.keyboard.press("Backspace");
    const next = await shown(host, id);
    expect(next).not.toBe(first);
    await open(host);
    await expect(menu(host).locator(`[data-conversation="${next}"][data-shown]`)).toHaveCount(1);
    await expect(menu(host).locator(`[data-conversation="${first}"]`)).toContainText("marmalade");
    await host.keyboard.press("Escape");
  });

  await test.step("the empty thread links back to the one before", async () => {
    await frame(host, id).locator(`[data-back-to="${first}"]`).click();
    await expect(prompts(host, id)).toHaveText([REMEMBER]);
    await expect(prompts(guest, id), "the guest's frame switches too").toHaveText([REMEMBER]);
  });

  await test.step("a guest switches the frame; its new conversation runs nothing", async () => {
    const before = {
      sessions: (await sessions(host)).length,
      logs: logs().length,
    };
    await open(guest);
    await menu(guest).locator("[data-new-conversation]").click();
    await expect(prompts(host, id), "the host sees it").toHaveCount(0);
    const fresh = await shown(guest, id);
    await expect.poll(() => shown(host, id)).toBe(fresh);
    expect((await sessions(host)).length, "no session began").toBe(before.sessions);
    expect(logs().length, "no log").toBe(before.logs);
    await expect(frame(host, id).locator("[data-agent-settings]")).not.toContainText(
      "starting agent…",
    );
    await open(guest);
    await menu(guest).locator(`[data-conversation="${first}"]`).click();
    await expect(prompts(host, id)).toHaveText([REMEMBER]);
  });

  await test.step("back in it, the agent remembers", async () => {
    const turn = await send(host, id, RECALL);
    await idle(host, id, { turn });
    await expect(frame(host, id).locator(".prose-canvas").last()).toContainText(/marmalade/i);
    await expect(frame(guest, id).locator(".prose-canvas").last()).toContainText(/marmalade/i);
  });

  await test.step("a view member gets the list only", async () => {
    await setRole(host, guest, "view");
    await open(guest);
    await expect(menu(guest).locator("[data-new-conversation]")).toBeDisabled();
    await expect(menu(guest)).toContainText("Read-only: you can't switch conversations.");
    await expect(menu(guest).locator(`[data-conversation="${first}"][data-shown]`)).toHaveCount(1);
    await guest.keyboard.press("Escape");
  });
});
