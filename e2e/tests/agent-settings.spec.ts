// Agent settings (finding 04): model, effort and the rest are ACP session
// config options, shown on the frame's chip, changed any time — a guest's
// change asked of the host like a prompt.
import { ask, newAgent } from "../agents";
import { clear, frame } from "../board";
import { expect, test } from "../fixtures";

test("model and effort, for everyone; a guest asks", async ({ host, guest }) => {
  await clear(host);
  const id = await newAgent(host, "claude");
  const chip = frame(host, id).locator("[data-agent-settings]");
  const guestChip = frame(guest, id).locator("[data-agent-settings]");
  const popover = (page = host) => page.locator("[data-agent-settings-popover]");

  await test.step("the host picks a model, then an effort it offers", async () => {
    await chip.click();
    await popover().locator("[data-choice=sonnet]").click();
    await popover()
      .locator("[data-setting=effort]")
      .getByRole("button", { name: "High", exact: true })
      .click();
    await expect(chip).toContainText("High", { timeout: 10_000 });
    await host.keyboard.press("Escape");
    await expect(guestChip, "the guest sees it").toContainText(/Sonnet.* · High/, {
      timeout: 10_000,
    });
  });

  await test.step("a guest's change waits for the host", async () => {
    await guestChip.click();
    await popover(guest)
      .locator("[data-setting=effort]")
      .getByRole("button", { name: "Low", exact: true })
      .click();
    const approve = host.getByRole("button", { name: "Run on my machine" });
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await approve.click();
    await expect(chip).toContainText(/Sonnet.* · Low/, { timeout: 10_000 });
    await guest.keyboard.press("Escape");
  });

  await test.step("the next prompt runs on the chosen model", async () => {
    await ask(host, id, "Which Claude model are you? Answer in five words or fewer.");
    await expect(frame(guest, id).locator(".prose-canvas").last()).toContainText(/sonnet/i);
  });
});

test("opencode's models are searchable", async ({ host }) => {
  await clear(host);
  const id = await newAgent(host, "opencode");
  await frame(host, id).locator("[data-agent-settings]").click();
  const popover = host.locator("[data-agent-settings-popover]");
  await popover.locator("input[aria-label=Search]").fill("glm 5.3");
  const found = popover.locator("[data-choice='opencode-go/glm-5.3']");
  await expect(found, "a search finds a model among hundreds").toBeVisible();
  await found.click();
  await expect(popover.locator("[data-setting=effort]"), "and its settings follow").toBeVisible({
    timeout: 10_000,
  });
  await host.keyboard.press("Escape");
});
