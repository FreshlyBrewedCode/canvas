// One host tab at a time: a second one takes over, "Use here" takes it back.
import type { Page } from "@playwright/test";
import { add, frame, settle } from "../board";
import { expect, open, test } from "../fixtures";

test("one host tab at a time", async ({ browser, host, guest, serve }, testInfo) => {
  const connected = (page: Page) => page.getByText("connected to canvas serve");
  const replaced = (page: Page) => page.locator("[data-host-elsewhere]");
  const second = await open(browser, serve.link, "Karl", "#f97316", testInfo);

  await test.step("a second tab takes over; the first is read-only", async () => {
    await expect(connected(second)).toBeVisible({ timeout: 15_000 });
    await expect(replaced(host)).toBeVisible({ timeout: 10_000 });
    await expect(host.locator("[data-hud]").getByRole("button", { name: "Agent" })).toHaveCount(0);
  });

  await test.step("guests follow the tab that has canvas serve", async () => {
    await expect(guest.getByText("host online")).toBeVisible({ timeout: 30_000 });
    const id = await add(guest, "Files");
    await expect(frame(second, id), "a guest's edit reaches the second tab").toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("Use here takes the board back, and neither takes it again by itself", async () => {
    await host.getByRole("button", { name: "Use here" }).click();
    await expect(connected(host)).toBeVisible({ timeout: 15_000 });
    await expect(replaced(second)).toBeVisible({ timeout: 10_000 });
    await settle(5000);
    await expect(connected(host), "the first tab is still the host 5 s later").toBeVisible();
    await expect(replaced(second), "the second tab still waits").toBeVisible();
    await expect(guest.getByText("host online")).toBeVisible({ timeout: 30_000 });
  });
  await second.context().close();
});
