// What waits on someone, in one place (`components/inbox.tsx`): the top bar's
// inbox counts it and lists it; a card over the board announces a knock or a
// guest's request until it is answered or put off for later.
import type { Page } from "@playwright/test";
import { expect, open, test } from "../fixtures";

const inbox = (page: Page) => page.locator("header [data-inbox]");
const list = (page: Page) => page.locator("[data-inbox-list]");
const cards = (page: Page) => page.locator("[data-arrivals]");

test("the inbox: knocks and guests' requests", async ({
  browser,
  host,
  guest,
  guestLink,
}, testInfo) => {
  /** A request that waits for the host's approval as edit: setting an agent's option. */
  const ask = () =>
    guest.evaluate(() => {
      (window as any).asked = (window as any).room
        .act({ t: "agent-config", sessionId: "none", configId: "model", value: "x" })
        .then(
          () => "ok",
          (e: Error) => e.message,
        );
    });
  const answer = () => guest.evaluate(() => (window as any).asked as Promise<string>);

  await test.step("nothing waits: an empty inbox", async () => {
    await expect(inbox(host)).toHaveAttribute("data-count", "0");
    await inbox(host).click();
    await expect(list(host)).toContainText("Nothing waits on you");
    await host.keyboard.press("Escape");
    await expect(inbox(guest)).toHaveAttribute("data-count", "0");
  });

  await test.step("a guest's request: a card for the host, waiting in the guest's inbox", async () => {
    await ask();
    const card = cards(host).locator('[data-approval="Ada"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(inbox(host)).toHaveAttribute("data-count", "1");
    await expect(inbox(guest)).toHaveAttribute("data-count", "1");
    await inbox(guest).click();
    await expect(list(guest).locator('[data-request="agent-config"]')).toContainText(
      "waits for the host to approve",
    );
    await guest.keyboard.press("Escape");
  });

  await test.step("put off for later, it waits in the inbox; answered there, it is gone", async () => {
    await cards(host).getByRole("button", { name: "Later" }).click();
    await expect(cards(host)).toHaveCount(0);
    await expect(inbox(host), "still counted").toHaveAttribute("data-count", "1");
    await inbox(host).click();
    await list(host).getByRole("button", { name: "Decline" }).click();
    expect(await answer()).toContain("declined");
    await expect(inbox(host)).toHaveAttribute("data-count", "0");
    await expect(inbox(guest)).toHaveAttribute("data-count", "0");
    await host.keyboard.press("Escape");
  });

  await test.step("a knock: a card, and in the inbox; while it is open, no second card", async () => {
    const bob = await open(browser, guestLink, "Bob", "#22c55e", testInfo);
    const knock = cards(host).locator('[data-knock="Bob"]');
    await expect(knock).toBeVisible({ timeout: 30_000 });
    await expect(inbox(host)).toHaveAttribute("data-count", "1");
    await inbox(host).click();
    await expect(cards(host), "the open inbox has it").toHaveCount(0);
    await list(host)
      .locator('[data-knock="Bob"]')
      .getByRole("button", { name: "Admit to view" })
      .click();
    await expect(bob.locator("[data-board]")).toBeVisible({ timeout: 30_000 });
    await expect(inbox(host)).toHaveAttribute("data-count", "0");
    await bob.context().close();
  });
});
