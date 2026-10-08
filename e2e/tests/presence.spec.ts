// Where everyone is (finding 19): people out of view get a marker on the
// viewport's edge; clicking an avatar follows that view until our own pan or zoom.
import type { Page } from "@playwright/test";
import { clear, settle } from "../board";
import { expect, test } from "../fixtures";

type View = { x: number; y: number; w: number; h: number };

/** A peer's marker on the edge, relative to the board: its centre, or null. */
const marker = (page: Page, name: string) =>
  page.evaluate((name) => {
    const el = document.querySelector(`[data-peer-marker="${name}"]`);
    if (!el) return null;
    const board = document.querySelector("[data-board]")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      x: Math.round(box.x + box.width / 2 - board.x),
      y: Math.round(box.y + box.height / 2 - board.y),
      w: Math.round(board.width),
      h: Math.round(board.height),
    };
  }, name);
const view = (page: Page) =>
  page.evaluate(() => (window as any).room.awareness.getLocalState().view as View);
const centre = (v: View) => ({ x: v.x + v.w / 2, y: v.y + v.h / 2 });

test("markers for people out of view", async ({ host, guest }) => {
  await clear(host);
  for (const page of [host, guest])
    await page.locator("[data-hud]").getByTitle("Reset to 100%").click();

  await test.step("in view, no marker; out of view, on the edge towards them", async () => {
    await guest.mouse.move(700, 450);
    await settle(600);
    expect(await marker(host, "Ada"), "Ada's cursor in view").toBeNull();
    await host.mouse.move(700, 450);
    for (let i = 0; i < 10; i++) await host.mouse.wheel(300, 0);
    await expect
      .poll(async () => (await marker(host, "Ada"))?.x, "on the left edge")
      .toBeLessThan(40);
    const at = (await marker(host, "Ada"))!;
    expect(at.y, "…halfway down").toBeNear(at.h / 2, 80);
  });

  await test.step("with her mouse off the board, it points at her view", async () => {
    await guest.mouse.move(700, 20);
    await settle(600);
    expect((await marker(host, "Ada"))?.x).toBeLessThan(40);
    await guest.mouse.move(700, 450);
    for (let i = 0; i < 20; i++) await guest.mouse.wheel(0, 400);
    await guest.mouse.move(700, 20);
    await expect
      .poll(async () => {
        const at = await marker(host, "Ada");
        return at ? at.h - at.y : null;
      }, "after she pans down, it is on the bottom edge")
      .toBeLessThan(80);
  });

  await test.step("her pointer moves over the board with her pan", async () => {
    await guest.mouse.move(700, 450);
    await settle(600);
    const pointer = () =>
      host.evaluate(() => {
        const room = (window as any).room;
        const ada = [...room.awareness.getStates().values()].find(
          (s: any) => s.user?.name === "Ada",
        );
        return ada?.pointer as { x: number; y: number } | null;
      });
    const before = (await pointer())!;
    for (let i = 0; i < 3; i++) await guest.mouse.wheel(0, 200);
    await expect.poll(async () => Math.round((await pointer())!.y - before.y)).toBe(600);
    await guest.mouse.move(700, 20);
    await settle(600);
  });

  await test.step("clicking the marker goes there", async () => {
    await host.locator('[data-peer-marker="Ada"]').click();
    await expect.poll(() => marker(host, "Ada")).toBeNull();
  });
});

test("following someone's view", async ({ host, guest }) => {
  await clear(host);
  const following = () =>
    host.evaluate(
      () =>
        document.querySelector("[data-following-view]")?.getAttribute("data-following-view") ??
        null,
    );
  const avatar = host.locator('header [data-avatar="Ada"]');
  /** Karl's view comes to be centred on Ada's, as wide (or, on a smaller screen of hers, holding it). */
  const sees = async (what: string, fits = false) => {
    await expect
      .poll(async () => {
        const [karl, ada] = [await view(host), await view(guest)];
        const [k, a] = [centre(karl), centre(ada)];
        const size = fits
          ? karl.w >= ada.w - 1 && karl.h >= ada.h - 1
          : Math.abs(karl.w - ada.w) <= 2;
        return Math.abs(k.x - a.x) <= 2 && Math.abs(k.y - a.y) <= 2 && size;
      }, what)
      .toBe(true);
  };

  await test.step("Karl clicks Ada's avatar: he sees what she sees", async () => {
    await host.mouse.move(700, 450);
    for (let i = 0; i < 5; i++) await host.mouse.wheel(0, -500);
    await avatar.click();
    await expect.poll(following).toBe("Ada");
    await sees("he sees what she sees");
  });

  await test.step("she pans and zooms; he goes with her, on any screen", async () => {
    await guest.locator("[data-board]").hover({ position: { x: 700, y: 450 } });
    for (let i = 0; i < 8; i++) await guest.mouse.wheel(250, 150);
    await guest.getByTitle("Zoom in").click();
    await guest.getByTitle("Zoom in").click();
    await sees("Ada pans and zooms, Karl goes with her");
    await guest.setViewportSize({ width: 900, height: 700 });
    await guest.mouse.move(450, 300);
    await guest.mouse.wheel(10, 0);
    await sees("on a smaller screen, her view fits in his, centred", true);
  });

  await test.step("he pans himself: he lets go, and stays where he is", async () => {
    await host.mouse.move(700, 450);
    await host.mouse.wheel(0, 300);
    await expect.poll(following).toBeNull();
    await settle(600);
    const karl = await view(host);
    for (let i = 0; i < 4; i++) await guest.mouse.wheel(300, 0);
    await settle(600);
    expect(await view(host), "Ada pans again: Karl's view stays").toEqual(karl);
  });

  await test.step("Stop, the avatar again, zooming or a middle drag let go", async () => {
    await avatar.click();
    await expect.poll(following, "he follows again").toBe("Ada");
    await sees("he follows again", true);
    await host.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await following(), "Stop lets go").toBeNull();
    await avatar.click();
    await avatar.click();
    expect(await following(), "the avatar again lets go").toBeNull();
    await avatar.click();
    await host.getByTitle("Zoom out").click();
    expect(await following(), "his zoom buttons let go").toBeNull();
    await avatar.click();
    await settle(600);
    await host.mouse.move(700, 450);
    await host.mouse.down({ button: "middle" });
    await host.mouse.move(800, 500, { steps: 5 });
    await host.mouse.up({ button: "middle" });
    expect(await following(), "a middle-button drag lets go").toBeNull();
  });

  await test.step("Ada leaves: he no longer follows her", async () => {
    await avatar.click();
    await settle(600);
    await guest.close();
    await expect(avatar).toHaveCount(0, { timeout: 30_000 });
    expect(await following()).toBeNull();
  });
});

test("you: your name and colour, for everyone", async ({ host, guest }) => {
  const you = host.locator("header [data-you]");
  const menu = host.locator("[data-you-menu]");
  const karlOnGuest = guest.locator("header [data-avatar]").first();

  await test.step("the header has no name field: our avatar, ringed, opens the menu", async () => {
    await expect(host.locator('header [aria-label="Your name"]')).toHaveCount(0);
    await expect(you).toHaveText("K");
    await you.click();
    await expect(menu.getByLabel("Your name")).toHaveValue("Karl");
    await expect(menu, "the host is told what hosting means").toContainText("You host this board");
  });

  await test.step("a new name, kept on Enter, reaches the guest", async () => {
    await menu.getByLabel("Your name").fill("Karla");
    await menu.getByLabel("Your name").press("Enter");
    await expect(you).toHaveAttribute("aria-label", "You: Karla");
    await expect(guest.locator('header [data-avatar="Karla"]')).toBeVisible({ timeout: 10_000 });
  });

  await test.step("a new colour, the same way; both kept by this browser", async () => {
    await menu.getByRole("button", { name: "Colour #a855f7" }).click();
    await expect(menu.getByRole("button", { name: "Colour #a855f7" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() => karlOnGuest.evaluate((el) => getComputedStyle(el).backgroundColor), {
        timeout: 10_000,
      })
      .toBe("rgb(168, 85, 247)");
    await host.keyboard.press("Escape");
    // The fixture sets the name again on every load: what this browser keeps is what counts.
    expect(await host.evaluate(() => JSON.parse(localStorage.getItem("canvas.identity")!))).toEqual(
      {
        name: "Karla",
        color: "#a855f7",
      },
    );
  });

  await test.step("a guest's menu says what it may do", async () => {
    await guest.locator("header [data-you]").click();
    await expect(guest.locator("[data-you-access]")).toContainText("can edit");
    await guest.keyboard.press("Escape");
  });
});
