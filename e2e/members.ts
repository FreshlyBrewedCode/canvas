/**
 * Members (ADR 0011): what the host lets a member's browser do, as the
 * members list sets it. A member is found by its browser's fingerprint.
 */
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

/** A browser's own key, as its page shows it. */
export const fingerprint = async (page: Page) =>
  (await page.locator("[data-fingerprint-self]").getAttribute("data-fingerprint-self"))!;

/** `page`'s row in the host's members list (open it first). */
export const memberRow = async (host: Page, page: Page) =>
  host.locator(`[data-member][data-fingerprint="${await fingerprint(page)}"]`);

/** The host sets what `page`'s browser may do, and waits until it knows. */
export async function setRole(host: Page, page: Page, role: "view" | "edit") {
  const row = await memberRow(host, page);
  await host.locator("[data-members-button]").click();
  await row.locator("select").selectOption(role);
  await host.keyboard.press("Escape");
  await expect(page.locator(`[data-access="${role}"]`)).toHaveCount(1, { timeout: 10_000 });
}

/** The host trusts `page`'s browser for this session, or takes it back (decision 4). */
export async function setTrusted(host: Page, page: Page, on: boolean) {
  const row = await memberRow(host, page);
  await host.locator("[data-members-button]").click();
  const toggle = row.getByRole("button", { name: /^(Trust|Take trusted back)/ });
  const role = await row.locator("select").inputValue();
  if ((await toggle.getAttribute("aria-pressed")) !== String(on)) await toggle.click();
  await host.keyboard.press("Escape");
  await expect(page.locator(`[data-access="${on ? "trusted" : role}"]`)).toHaveCount(1, {
    timeout: 10_000,
  });
}

/** The host removes `page`'s browser from the members. */
export async function remove(host: Page, page: Page) {
  const row = await memberRow(host, page);
  await host.locator("[data-members-button]").click();
  await row.getByRole("button", { name: /^Remove/ }).click();
  await host.keyboard.press("Escape");
}

/** The guest link the host's board gives now: after a reset, not the first one (decision 6). */
export async function copyGuestLink(host: Page) {
  await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await host.getByRole("button", { name: "Copy guest link" }).click();
  return host.evaluate(() => navigator.clipboard.readText());
}

/** A request from `page` to `canvas serve`, through the host: "ok", or why it was refused. */
export const request = (page: Page, req: Record<string, unknown>) =>
  page.evaluate(
    (r) =>
      (window as any).room.act(r).then(
        () => "ok",
        (e: Error) => e.message,
      ),
    req,
  );
