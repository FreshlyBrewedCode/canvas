// The keyboard (ADR 0010, decision 9): moves over the tree, for the left hand.
import type { Page } from "@playwright/test";
import {
  add,
  arrange,
  at,
  clear,
  fit,
  frame,
  frames as all,
  mine,
  settle,
  transform,
} from "../board";
import { expect, test } from "../fixtures";

test("the keyboard moves over the tree", async ({ host }) => {
  await clear(host);
  // A cluster of a b c over d, and g in a cluster of its own right of it.
  const ids: string[] = [];
  for (const kind of ["Files", "Drawing", "Drawing", "Drawing", "Drawing"])
    ids.push(await add(host, kind));
  const [a, b, c, d, g] = ids as [string, string, string, string, string];
  await arrange(host, {
    [a]: { x: 0, y: 0, w: 600, h: 400 },
    [b]: { x: 600, y: 0, w: 600, h: 400 },
    [c]: { x: 1200, y: 0, w: 600, h: 400 },
    [d]: { x: 0, y: 400, w: 600, h: 400 },
    [g]: { x: 3000, y: 0, w: 600, h: 400 },
  });
  await fit(host);
  const press = async (key: string) => {
    await host.keyboard.press(key);
    await settle();
  };
  const current = () => mine(host);
  const header = async (id: string) => {
    const box = (await frame(host, id).boundingBox())!;
    return { x: box.x + box.width * 0.6, y: box.y + 8 };
  };
  const board = (await host.locator("[data-board]").boundingBox())!;
  const inView = (id: string) => inside(host, id, board);

  await test.step("W A S D go to the neighbouring frame, occupying it", async () => {
    const h = await header(a);
    await host.mouse.click(h.x, h.y);
    await expect.poll(current, { message: "a press occupies a" }).toBe(a);
    await press("d");
    expect(await current(), "D goes right, to b").toBe(b);
    await press("l");
    expect(await current(), "…and L, to c").toBe(c);
    await press("d");
    expect(await current(), "past the row's end, D goes over to the next cluster").toBe(g);
    await press("a");
    expect(await current(), "A comes back").toBe(c);
    await press("e");
    expect(await current(), "E goes to the cluster after").toBe(g);
    await press("q");
    expect(await current(), "Q to the cluster before, its first frame").toBe(a);
    await press("s");
    expect(await current(), "S goes down, to d").toBe(d);
    await press("w");
    expect(await current(), "W back up").toBe(a);
  });

  await test.step("Shift + W A S D move the current frame", async () => {
    await press("Shift+D");
    const [ma, mb] = [await at(host, a), await at(host, b)];
    expect(ma.row, "Shift + D moves a into b's row").toBe(mb.row);
    expect(ma.x, "…after b").toBeGreaterThan(mb.x);
    expect(await current(), "…and a stays the current frame").toBe(a);
    await press("Shift+S");
    expect((await at(host, a)).row, "Shift + S moves it into the row below").toBe(
      (await at(host, d)).row,
    );
    await press("Shift+W");
    expect((await at(host, a)).row, "Shift + W back up").toBe((await at(host, b)).row);
  });

  await test.step("1 – 5 add a frame beside the current one; Shift + X closes it", async () => {
    await press("2");
    const added = (await all(host)).find((f) => !ids.includes(f.id));
    expect(added?.type, "2 adds a files frame").toBe("file");
    const A = await at(host, a);
    expect(added!.row, "…in the current frame's row").toBe(A.row);
    expect(added!.x, "…right beside it").toBe(A.x + A.w);
    expect(await current(), "…and it is the current frame").toBe(added!.id);
    await press("Shift+X");
    expect(
      (await all(host)).map((f) => f.id),
      "Shift + X closes the current frame",
    ).not.toContain(added!.id);
    expect(await current(), "…and goes on to the one beside it").toBe(a);
    const h = await header(a);
    await host.mouse.click(h.x, h.y);
    await settle();
  });

  await test.step("F: full screen; D along its row; S to the row below; F back", async () => {
    const fullscreen = () =>
      host.locator("[data-fullscreen-dot][aria-current]").getAttribute("data-fullscreen-dot");
    await press("f");
    expect(await fullscreen(), "F: full screen on the current frame").toBe(a);
    const dots = await host
      .locator("[data-fullscreen-dot]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-fullscreen-dot")));
    const i = dots.indexOf(a);
    // Along: to the next, or, from the row's last, back to the one before.
    await press(dots[i + 1] ? "d" : "a");
    expect(await fullscreen(), "D / A go along the row").toBe(dots[i + 1] ?? dots[i - 1]);
    expect(await current(), "…occupying the frame").toBe(await fullscreen());
    await press("s");
    expect(await fullscreen(), "S goes to the row below, full screen").toBe(d);
    await press("f");
    await expect(host.locator("[data-fullscreen-bar]"), "F leaves full screen").toHaveCount(0);
  });

  await test.step("Shift + F: the whole board; again, back", async () => {
    await host.locator("[data-hud]").getByTitle("Reset to 100%").click();
    await settle();
    const was = await transform(host);
    const eases = () =>
      host.evaluate(
        () => (document.querySelector("[data-board] > div") as HTMLElement).style.transition,
      );
    await press("Shift+F");
    for (const id of ids) expect(await inView(id), `Shift + F shows ${id}`).toBe(true);
    expect(await eases(), "…gliding there").toContain("transform");
    await press("Shift+F");
    await settle(300);
    expect(await transform(host), "…and again, back").toBe(was);
  });

  await test.step("in the whole board, W A S D stay in it; Shift + F goes to where they went", async () => {
    // On a small screen, so the whole board is below a readable zoom.
    const size = host.viewportSize()!;
    await host.setViewportSize({ width: 900, height: 600 });
    await settle();
    const from = await current();
    await press("Shift+F");
    const whole = await transform(host);
    await press("w");
    const went = (await current())!;
    expect(went, "W in the whole board goes to another frame").not.toBe(from);
    expect(await transform(host), "…and stays in the whole board").toBe(whole);
    await press("Shift+F");
    expect(await inView(went), "…and Shift + F goes back to that frame").toBe(true);
    expect(await transform(host), "…at the zoom before").toContain("scale(1)");
    await host.setViewportSize(size);
    await host.locator("[data-hud]").getByTitle("Reset to 100%").click();
    await settle();
  });

  await test.step("going to a frame off screen brings it into view", async () => {
    expect(await inView(g), "at 100%, g is off screen").toBe(false);
    await press("e");
    expect(await current(), "E goes to g").toBe(g);
    expect(await inView(g), "…and the view goes along").toBe(true);
  });

  await test.step("typing is the field's; Esc leaves the field", async () => {
    const title = frame(host, g).getByLabel("Frame title");
    const name = await title.inputValue();
    await title.click();
    await host.keyboard.press("End");
    await host.keyboard.type("wasd");
    await expect(title, "keys type into a title").toHaveValue(`${name}wasd`);
    expect(await current()).toBe(g);
    await press("Escape");
    expect(
      await host.evaluate(() => document.activeElement === document.body),
      "Esc leaves the field for the board",
    ).toBe(true);
    await press("q");
    expect((await at(host, (await current())!)).cluster, "…and Q works again").toBe(
      (await at(host, b)).cluster,
    );
  });
});

/** Whether a frame is wholly inside the board's box on screen. */
async function inside(
  page: Page,
  id: string,
  board: { x: number; y: number; width: number; height: number },
) {
  const box = (await frame(page, id).boundingBox())!;
  return (
    box.x >= board.x - 1 &&
    box.y >= board.y - 1 &&
    box.x + box.width <= board.x + board.width + 1 &&
    box.y + box.height <= board.y + board.height + 1
  );
}
