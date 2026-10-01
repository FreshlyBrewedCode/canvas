// Frame focus (finding 08): who occupies a frame drives its scroll for
// everyone following; an agent's claim gives way to a person.
import type { Page } from "@playwright/test";
import { add, arrange, clear, fit, frame, settle } from "../board";
import { expect, test } from "../fixtures";

test("the occupant drives a frame's scroll", async ({ host, guest }) => {
  await clear(host);
  const a = await add(host, "Files");
  const b = await add(host, "Files");
  await arrange(host, {
    [a]: { path: "src/big.ts", title: "big.ts", x: 0, y: 0, w: 640, h: 480 },
    [b]: { path: "docs/notes.md", title: "notes.md", x: 700, y: 0, w: 640, h: 480 },
  });
  for (const page of [host, guest]) {
    await frame(page, a).locator("diffs-container").waitFor({ timeout: 10_000 });
    await frame(page, b).locator(".prose-canvas").waitFor({ timeout: 10_000 });
    await fit(page);
  }

  const occupant = (page: Page, id: string) => frame(page, id).getAttribute("data-occupant");
  const following = (page: Page, id: string) =>
    frame(page, id).evaluate((el) => el.hasAttribute("data-following"));
  /** The frame's main scroller: the code view's virtualizer, or the preview. */
  const scroll = (page: Page, id: string) =>
    frame(page, id).evaluate((el) => {
      const code = el.querySelector("diffs-container")?.closest(".overflow-auto");
      const node = (code ?? el.querySelector(".overflow-auto")) as HTMLElement;
      return Math.round(node.scrollTop);
    });
  const middle = async (page: Page, id: string) => {
    const box = (await frame(page, id).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const press = async (page: Page, id: string) => {
    const at = await middle(page, id);
    await page.mouse.click(at.x, at.y);
  };
  const wheel = async (page: Page, id: string, dy: number) => {
    const at = await middle(page, id);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, dy);
  };
  /** The guest's scroll catches up with the host's. */
  const together = async (id: string, from: Page, to: Page) => {
    await expect
      .poll(async () => Math.abs((await scroll(from, id)) - (await scroll(to, id))))
      .toBeLessThanOrEqual(2);
  };

  await test.step("the host presses A: theirs; the guest follows", async () => {
    await press(host, a);
    await expect.poll(() => occupant(guest, a)).toBe("Karl");
    expect(await occupant(host, a)).toBe("Karl");
    expect(await following(host, a), "the occupant follows no one").toBe(false);
    expect(await following(guest, a), "the guest follows").toBe(true);
  });

  await test.step("the host scrolls A: the guest's A goes along", async () => {
    await wheel(host, a, 1600);
    await expect.poll(() => scroll(host, a)).toBeGreaterThan(0);
    await together(a, host, guest);
  });

  await test.step("the guest scrolls A: detached, just for them", async () => {
    await press(guest, a);
    await wheel(guest, a, -600);
    await expect.poll(() => following(guest, a)).toBe(false);
    expect(await occupant(guest, a), "A stays Karl's").toBe("Karl");
    expect(await occupant(host, a)).toBe("Karl");
    await settle(700);
    const own = await scroll(guest, a);
    await wheel(host, a, 1600);
    await settle(1000);
    expect(await scroll(guest, a), "the detached guest keeps its own scroll").toBe(own);
    expect(await scroll(host, a)).not.toBe(own);
  });

  await test.step("the guest clicks Karl's badge: following again", async () => {
    await frame(guest, a).locator("[data-occupant-badge]").click();
    await expect.poll(() => following(guest, a)).toBe(true);
    await together(a, host, guest);
  });

  await test.step("the guest presses B: theirs; the host follows the preview", async () => {
    await press(guest, b);
    await expect.poll(() => occupant(host, b)).toBe("Ada");
    await wheel(guest, b, 900);
    await expect.poll(() => scroll(guest, b)).toBeGreaterThan(0);
    await together(b, guest, host);
  });

  await test.step("pressing an occupied frame, or the board, gives yours up", async () => {
    await press(host, b);
    await expect.poll(() => occupant(guest, a), "the host pressing B frees A").toBeNull();
    expect(await occupant(guest, b), "B stays Ada's").toBe("Ada");
    const board = (await guest.locator("[data-board]").boundingBox())!;
    await guest.mouse.click(board.x + 30, board.y + board.height - 30);
    await expect.poll(() => occupant(host, b), "the guest pressing the board frees B").toBeNull();
  });

  await test.step("a person takes a frame over from an agent", async () => {
    // As the host does for a board tool call.
    await host.evaluate(([id]) => (window as any).room.claimForAgent("agent-x", id), [a]);
    await expect.poll(() => occupant(guest, a)).toBe("agent");
    expect(await following(guest, a), "the guest follows the agent").toBe(true);
    await press(guest, a);
    await expect.poll(() => occupant(host, a)).toBe("Ada");
    expect(
      await host.evaluate(() => (window as any).room.awareness.getLocalState().agents),
      "the agent's claim is dropped",
    ).toEqual([]);
  });

  await test.step("a terminal's scrollback follows its occupant", async () => {
    const t = await add(host, "Terminal");
    await arrange(host, { [t]: { x: 0, y: 540, w: 640, h: 360 } });
    for (const page of [host, guest]) await fit(page);
    await settle(800);
    await press(host, t);
    await host.keyboard.type("seq 1 400\n");
    const first = (page: Page) => frame(page, t).locator(".xterm-rows > div").first().innerText();
    await expect.poll(() => first(host)).not.toBe("");
    await expect(frame(host, t).locator(".xterm-rows")).toContainText("400");
    const bottom = await first(host);
    for (let i = 0; i < 10; i++) await wheel(host, t, -150);
    await expect.poll(() => first(host)).not.toBe(bottom);
    await expect.poll(async () => (await first(guest)) === (await first(host))).toBe(true);
  });
});
