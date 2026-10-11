// An agent frame's thread (findings 03, 04): prompts written together and
// approved by the host, what people see while it runs and once it's done.
// The agent is opencode, replayed from its recordings (`e2e/acp/cassette.ts`).
import type { Locator, Page } from "@playwright/test";
import { ask, idle, newAgent, send } from "../agents";
import { clear, frame, settle } from "../board";
import { expect, test } from "../fixtures";

const composer = (page: Page, id: string) => frame(page, id).locator("[data-composer] .cm-content");
/** A frame's shared prompt draft, as a page's doc has it. */
const draftOf = (page: Page, id: string) =>
  page.evaluate((id) => (window as any).room.doc.getText(`prompt:${id}`).toString(), id);

test("a guest's prompt runs once the host approves", async ({ host, guest }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");

  await test.step("both write into the same draft", async () => {
    await composer(guest, id).click();
    await guest.keyboard.type("Create docs/plan.md with a 3-step plan for a todo app. ");
    await expect.poll(() => draftOf(host, id)).toMatch(/a todo app\. $/);
    await composer(host, id).click();
    await host.keyboard.press("End");
    await host.keyboard.type("Keep it short.");
    await expect
      .poll(() => draftOf(guest, id))
      .toBe("Create docs/plan.md with a 3-step plan for a todo app. Keep it short.");
  });

  await test.step("the guest sends; it runs once the host approves", async () => {
    await guest.keyboard.press("Control+Enter");
    const run = host.getByRole("button", { name: "Run on my machine" });
    await expect(run).toBeVisible({ timeout: 10_000 });
    await expect(frame(host, id).locator("[data-sel-key$=':prompt']")).toHaveCount(0);
    await run.click();
    await expect(frame(guest, id).locator("[data-sel-key$=':prompt']").first()).toBeVisible();
    await idle(host, id, { turn: 1 });
    await expect(frame(guest, id).locator(".prose-canvas").last(), "the reply").not.toBeEmpty();
  });

  await test.step("a guest's selection in the thread shows for the host", async () => {
    await guest.evaluate((frameId) => {
      const el = document.querySelector(`[data-frame="${frameId}"] [data-sel-key$=':prompt']`)!;
      const range = document.createRange();
      range.setStart(el.firstChild!, 7);
      range.setEnd(el.firstChild!, 30);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    }, id);
    await expect
      .poll(() => frame(host, id).locator("[data-sel-root] [aria-hidden] > div").count())
      .toBeGreaterThan(0);
  });
});

test("agents waiting on a permission are hard to miss", async ({ host, guest }) => {
  await clear(host);
  for (const page of [host, guest])
    await page.locator("[data-hud]").getByTitle("Reset to 100%").click();
  const id = await newAgent(host, "opencode");
  const needs = (page: Page) => page.locator(`[data-needs-host="${id}"]`);
  const inbox = (page: Page) => page.locator("header [data-inbox]");
  /** The agent's line in `page`'s inbox; it opens it. */
  const listed = async (page: Page) => {
    await inbox(page).click();
    return page.locator(`[data-inbox-list] [data-waiting="${id}"]`);
  };
  // Reading outside the project makes opencode ask (its default policy).
  await send(host, id, "Read the file /etc/hostname with your read tool and tell me what it says.");

  await test.step("the header, the outline and the inbox say so", async () => {
    await expect(needs(host)).toContainText("needs you", { timeout: 60_000 });
    await expect(frame(host, id)).toHaveAttribute("data-attention", /.*/);
    await expect(needs(guest)).toContainText("needs host");
    await expect(inbox(host)).toHaveAttribute("data-count", "1");
    await expect(await listed(host)).toContainText("asks for a permission");
    await host.keyboard.press("Escape");
    await expect(await listed(guest)).toContainText("waits for the host's permission");
    await guest.keyboard.press("Escape");
    await expect(host.locator("[data-waiting-marker]"), "in view: no marker").toHaveCount(0);
  });

  await test.step("out of view, a marker; it and the inbox go there", async () => {
    await host.mouse.move(60, 820);
    for (let i = 0; i < 10; i++) await host.mouse.wheel(400, 0);
    await expect(host.locator(`[data-waiting-marker="${id}"]`)).toHaveCount(1);
    await host.locator(`[data-waiting-marker="${id}"]`).click();
    await expect(host.locator("[data-waiting-marker]")).toHaveCount(0);
    for (let i = 0; i < 10; i++) await host.mouse.wheel(0, 400);
    await settle(600);
    await (await listed(host)).getByRole("button", { name: "Go there" }).click();
    await expect(host.locator("[data-waiting-marker]")).toHaveCount(0);
  });

  await test.step("answering it ends all of it", async () => {
    await frame(host, id).locator("[data-permission-kind=allow_once]").first().click();
    await expect(needs(host)).toHaveCount(0, { timeout: 30_000 });
    await expect(inbox(host)).toHaveAttribute("data-count", "0");
    await expect(frame(host, id)).not.toHaveAttribute("data-attention", /.*/);
    await idle(host, id, { turn: 1 });
  });
});

test("runs of tool calls fold, and a button goes back to the latest", async ({ host }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  await ask(
    host,
    id,
    "Read README.md, then math.ts, with your read tool, in two separate calls. " +
      "Then reply with a numbered list of 40 fruits, one per line.",
  );
  const body = frame(host, id).locator("[data-frame-body]");
  const latest = frame(host, id).locator("[data-to-latest]");

  await test.step("tool calls in a row fold, saying how many", async () => {
    await expect(latest, "at the end: no jump button").toHaveCount(0);
    // Tool calls left unfolded with nothing but reasoning between them: folding is broken.
    const unfolded = await host.evaluate((id) => {
      const rows = document.querySelectorAll(`[data-frame="${id}"] [data-row]`);
      const turns = new Set(
        [...rows].filter((el) => !el.closest("[data-steps]")).map((el) => el.parentElement!),
      );
      let most = 0;
      for (const turn of turns) {
        let run = 0;
        for (const child of turn.children) {
          const kind = child.getAttribute("data-row");
          if (kind === "tool") most = Math.max(most, ++run);
          else if (kind !== "thinking") run = 0;
        }
      }
      return most;
    }, id);
    expect(unfolded, "no run of tool calls left unfolded").toBeLessThan(2);
    const steps = frame(host, id).locator("[data-steps]").first();
    await expect(steps).toContainText(/\d+ tool calls/);
    await steps.getByRole("button").first().click();
    expect(await steps.getByRole("button").count(), "a click unfolds them").toBeGreaterThanOrEqual(
      3,
    );
  });

  await test.step("scrolled up: a way back; more arriving says so", async () => {
    await body.evaluate((el) => (el.scrollTop = 0));
    await expect(latest).toHaveAttribute("data-to-latest", "yes");
    await send(host, id, "Now a numbered list of 30 vegetables, one per line.");
    await expect(frame(host, id).locator("[data-to-latest=news]")).toBeVisible({ timeout: 60_000 });
    expect(await body.evaluate((el) => el.scrollTop), "…and we stay where we were").toBe(0);
    await idle(host, id, { turn: 2 });
    await latest.click();
    await expect
      .poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(40);
    await expect(latest, "the button goes").toHaveCount(0);
  });
});

test("the mode chip goes round the agent's modes", async ({ host, guest }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  const chip = (page: Page) => frame(page, id).locator("[data-mode-chip]");
  const settled = async () => {
    await expect(chip(host)).not.toBeDisabled({ timeout: 30_000 });
    return (await chip(host).getAttribute("data-mode-chip"))!;
  };
  await expect(chip(host)).toHaveAttribute("data-mode-tone", "default", { timeout: 30_000 });
  const first = await settled();

  await chip(host).click();
  await expect(chip(host)).not.toHaveAttribute("data-mode-chip", first, { timeout: 30_000 });
  const second = await settled();
  expect(await chip(host).getAttribute("data-mode-tone"), "the next mode stands out").not.toBe(
    "default",
  );
  await expect(
    frame(guest, id).locator(`[data-mode-chip="${second}"]`),
    "the guest sees it",
  ).toHaveCount(1);

  // Shift+Tab in the composer goes round, never to bypassing permissions.
  const seen = [first, second];
  await composer(host, id).click();
  for (let i = 0; i < 8 && seen.at(-1) !== first; i++) {
    await host.keyboard.press("Shift+Tab");
    await settle(300);
    const now = await settled();
    if (now !== seen.at(-1)) seen.push(now);
  }
  expect(seen.at(-1), `Shift+Tab goes round: ${seen.join(" → ")}`).toBe(first);
  expect(seen.some((m) => /bypass/i.test(m))).toBe(false);
});

test("copy buttons in the thread", async ({ host }) => {
  await clear(host);
  await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await newAgent(host, "opencode");
  const text =
    "Reply with the sentence 'Here it is.' and then a ts code block containing exactly: const x = 1;";
  await ask(host, id, text);
  const of = frame(host, id);
  // Hidden is transparent: Playwright counts that as visible.
  const shown = async (button: Locator) => {
    await settle(250);
    return button.evaluate((el) => getComputedStyle(el).opacity === "1");
  };
  const copy = async (within: Locator) => {
    await within.hover();
    const button = within.locator(":scope > [data-copy], :scope > div > [data-copy]");
    expect(await shown(button), "the copy button shows on hover").toBe(true);
    await button.click();
    return host.evaluate(() => navigator.clipboard.readText());
  };
  expect((await copy(of.locator(".group\\/code").first())).trim(), "a code block").toBe(
    "const x = 1;",
  );
  const markdown = await copy(of.locator(".group\\/copy:has(.prose-canvas)").last());
  expect(markdown, "a message copies its markdown").toContain("```");
  expect(markdown).toContain("Here it is.");
  expect(await copy(of.locator(".group\\/copy:has([data-sel-key$=':prompt'])").first())).toBe(text);
  await host.mouse.move(5, 5);
  await settle(1600);
  const buttons = of.locator("[data-copy]");
  for (let i = 0; i < (await buttons.count()); i++)
    expect(await shown(buttons.nth(i)), "no buttons without the hover").toBe(false);
});

test.describe(() => {
  // The turn in real time (up to a second between messages): it runs long enough to watch.
  test.use({ serveEnv: { CANVAS_REPLAY_GAP_MS: "1000" } });

  test("time, tokens and context of a turn", async ({ host, guest }) => {
    await clear(host);
    const id = await newAgent(host, "opencode");
    const of = frame(host, id);
    await expect(of.locator("[data-usage-ring]"), "no usage yet: no ring").toHaveCount(0);
    await send(host, id, "Count slowly from 1 to 5 in words, one per line.");
    await expect(
      of.locator("[data-turn-footer=running]"),
      "while it runs, the time goes",
    ).toContainText(/^working/, { timeout: 30_000 });
    await idle(host, id, { turn: 1 });
    const done = of.locator("[data-turn-footer=done]");
    await expect(done, "once done: time and tokens").toHaveText(/^\d+s · [\d.]+k? tokens$/);
    const ring = of.locator("[data-usage-ring]");
    await expect(ring).toBeVisible();
    await ring.hover();
    const popover = host.locator("[data-usage-popover]");
    await expect(popover, "hovering it shows the session's usage").toContainText("tokens");
    await host.mouse.move(700, 120);
    await expect(popover, "…until the mouse leaves").toHaveCount(0);
    await ring.click();
    await host.mouse.move(700, 120);
    await settle(600);
    await expect(popover, "a click keeps it open").toHaveCount(1);
    await ring.click();
    await expect(popover, "another closes it").toHaveCount(0);
    await expect(
      frame(guest, id).locator("[data-turn-footer=done]"),
      "the guest sees the same",
    ).toHaveText((await done.innerText()).trim());
  });
});

test("prompt history: ↑ and ↓, and reusing a prompt", async ({ host, guest }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  const draft = () => draftOf(host, id);
  for (const prompt of ["Reply with just: A", "Reply with just: B"]) await ask(host, id, prompt);

  await test.step("↑ and ↓ go through our prompts", async () => {
    await composer(host, id).click();
    const seen: string[] = [];
    for (const key of ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown"]) {
      await host.keyboard.press(key);
      seen.push(await draft());
    }
    expect(seen).toEqual([
      "Reply with just: B",
      "Reply with just: A",
      "Reply with just: A",
      "Reply with just: B",
      "",
    ]);
  });

  await test.step("not over someone's draft; not someone else's prompts", async () => {
    await composer(guest, id).click();
    await guest.keyboard.type("Ada writes");
    await expect.poll(draft).toBe("Ada writes");
    await composer(host, id).click();
    await host.keyboard.press("Control+Home");
    await host.keyboard.press("ArrowUp");
    expect(await draft(), "↑ leaves a draft someone wrote alone").toBe("Ada writes");
    await guest.keyboard.press("Control+a");
    await guest.keyboard.press("Backspace");
    await expect.poll(draft).toBe("");
    await guest.keyboard.press("ArrowUp");
    await settle(300);
    expect(await draft(), "the guest's ↑ has none of the host's prompts").toBe("");
  });

  await test.step("a prompt back into the draft, from the thread", async () => {
    const prompt = frame(host, id).locator(".group\\/copy:has([data-sel-key$=':prompt'])").first();
    await prompt.hover();
    await prompt.locator("[data-reuse]").click();
    expect(await draft()).toBe("Reply with just: A");
    expect(
      await host.evaluate(() => !!document.activeElement?.closest("[data-composer]")),
      "…with the composer focused",
    ).toBe(true);
    await prompt.hover();
    await prompt.locator("[data-reuse]").click();
    expect(await draft(), "into a draft with text, it goes after it").toBe(
      "Reply with just: A\n\nReply with just: A",
    );
  });
});

// The agent's plan (ACP `plan` updates, or a todo tool's calls) above the composer.
test("the agent's plan shows above the composer", async ({ host, guest }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  const plan = (page: Page) => frame(page, id).locator("[data-plan]");
  await ask(
    host,
    id,
    "Use your todo list tool to plan three steps: 'look around', 'think', 'answer'. " +
      "Then mark them in progress and completed one by one, updating the todo list each time, " +
      "and reply with just 'done'. Do nothing else.",
  );
  const statuses = () =>
    plan(host)
      .locator("[data-plan-status]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-plan-status")));
  expect(await statuses(), "three steps, all done once the turn ends").toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  await expect(plan(guest).locator("[data-plan-status]"), "the guest sees it too").toHaveCount(3);
  await plan(guest).getByRole("button").first().click();
  await expect(
    plan(guest).locator("[data-plan-status]"),
    "folding it is the guest's own",
  ).toHaveCount(0);
  await expect(plan(host).locator("[data-plan-status]")).toHaveCount(3);
});
