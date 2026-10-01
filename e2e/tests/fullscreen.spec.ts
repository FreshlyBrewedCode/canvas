// Full screen (finding 20): our own view of one row at 100%, its frames as
// tall as the screen (terminals excepted), the rest hidden; nothing of it in
// the doc. Frames move along the row only, scrolling it at the board's sides;
// the frame we are on stays put as others change the row (ADR 0010, decision 8).
import type { Page } from "@playwright/test";
import { add, arrange, at, clear, fit, frame, settle, transform } from "../board";
import { expect, test } from "../fixtures";

test("full screen on a row", async ({ host, guest }) => {
  test.setTimeout(120_000);
  await clear(host);
  // A row of three, a terminal last, and a frame in the row under it.
  const files = await add(host, "Files");
  const draw = await add(host, "Drawing");
  const term = await add(host, "Terminal");
  const web = await add(host, "Browser");
  await arrange(host, {
    [files]: { x: 0, y: 0, w: 600, h: 400 },
    [draw]: { x: 624, y: 0, w: 600, h: 400 },
    [term]: { x: 1248, y: 0, w: 560, h: 400 },
    [web]: { x: 0, y: 424, w: 600, h: 400 },
  });
  await fit(host);
  await settle();

  const mode = (id: string, page: Page = host) => frame(page, id).getAttribute("data-fullscreen");
  const current = () =>
    host.locator("[data-fullscreen-dot][aria-current]").getAttribute("data-fullscreen-dot");
  const order = () =>
    host
      .locator("[data-fullscreen-dot]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-fullscreen-dot")));
  const on = async () => (await host.locator("[data-fullscreen-bar]").count()) > 0;
  const board = (await host.locator("[data-board]").boundingBox())!;
  const ada = (fn: string, ...args: unknown[]) =>
    guest.evaluate(([fn, args]) => (window as any)[fn as string](...(args as unknown[])), [
      fn,
      args,
    ] as const);

  await test.step("F on the frame we are in: 100%, as tall as the screen, its row", async () => {
    const b = (await frame(host, files).boundingBox())!;
    await host.mouse.click(b.x + b.width * 0.6, b.y + 10);
    await host.keyboard.press("f");
    await settle();
    const box = (await frame(host, files).boundingBox())!;
    expect(await transform(host), "at 100%").toContain("scale(1)");
    expect(box.y, "its top under the top bar").toBeNear(board.y, 1);
    expect(box.height, "as tall as the screen").toBeNear(board.height, 1);
    expect(box.x + box.width / 2, "in the middle").toBeNear(board.width / 2, 1);
    expect([await mode(draw), await mode(term)], "with its row").toEqual(["in", "in"]);
    expect(await mode(web), "the row under it hidden").toBe("hidden");
    expect(
      (await frame(host, term).boundingBox())!.height,
      "a terminal is half the host's screen",
    ).toBeNear(board.height / 2);
    expect((await at(host, files)).h, "the doc keeps the frame's height").toBe(400);
    await expect(host.locator("[data-hud]").getByTitle("Zoom in"), "no zoom controls").toBeHidden();
    await expect(
      host.locator("[data-hud]").getByRole("button", { name: "Agent" }),
      "no frame toolbar",
    ).toBeHidden();
    await settle(600);
    expect(await mode(files, guest), "the guest's board isn't full screen").toBeNull();
    const [gf, gw] = [
      (await frame(guest, files).boundingBox())!,
      (await frame(guest, web).boundingBox())!,
    ];
    expect(gf.height / gw.height, "…its frames keep their heights").toBeNear(1, 0.01);
    expect(await frame(guest, files).getAttribute("data-occupant"), "Karl occupies it").toBe(
      "Karl",
    );
  });

  await test.step("along the row: l, Alt + →, h, each claiming its frame", async () => {
    await host.mouse.move(board.x + board.width / 2, 20);
    await host.keyboard.press("l");
    await settle();
    expect(await current(), "l goes to the next frame").toBe(draw);
    const box = (await frame(host, draw).boundingBox())!;
    expect(box.x + box.width / 2, "…and shows it in the middle").toBeNear(board.width / 2, 1);
    const url = host.url();
    await host.keyboard.press("Alt+ArrowRight");
    await settle();
    expect(await current(), "Alt + → goes to the next").toBe(term);
    expect(host.url(), "…and not Back or Forward").toBe(url);
    await host.keyboard.press("l");
    await settle();
    expect(await current(), "l at the end stays").toBe(term);
    await host.keyboard.press("h");
    await host.keyboard.press("Alt+ArrowLeft");
    await settle();
    expect(await current(), "h and Alt + ← go back").toBe(files);
    await expect
      .poll(() => frame(guest, files).getAttribute("data-occupant"), "…claiming it")
      .toBe("Karl");
  });

  await test.step("typing f into a title stays full screen", async () => {
    const title = frame(host, files).getByLabel("Frame title");
    await title.click();
    await host.keyboard.press("End");
    await host.keyboard.type("f");
    expect(await on()).toBe(true);
    await host.keyboard.press("Backspace");
    // Away from the title, on the top bar's empty edge: not on the dots in its middle.
    await host.mouse.click(4, 24);
  });

  await test.step("dragging a header only reorders the row", async () => {
    const header = (await frame(host, files).getByLabel("Frame title").boundingBox())!;
    const drawBefore = (await frame(host, draw).boundingBox())!;
    await host.mouse.move(header.x + header.width + 60, header.y + 5);
    await host.mouse.down();
    // Over the terminal's left half as the row shows without it, clear of the board's side.
    await host.mouse.move(header.x + header.width + 560, header.y + 105, { steps: 8 });
    await settle(300);
    const drawDuring = (await frame(host, draw).boundingBox())!;
    expect(drawDuring.x, "the others make room").toBeLessThan(drawBefore.x - 300);
    await host.mouse.up();
    await settle();
    const [moved, swapped] = [await at(host, files), await at(host, draw)];
    expect([moved.x, moved.y, swapped.x, swapped.y], "into the row, not up or down").toEqual([
      600, 0, 0, 0,
    ]);
    expect(await on(), "still full screen").toBe(true);
    expect(await current(), "the view going after it").toBe(files);
    expect((await order()).slice(0, 2), "the dots in its new order").toEqual([draw, files]);
  });

  await test.step("held at the board's side, a drag scrolls the row", async () => {
    const edgeDrag = async (clientX: number) => {
      const grip = (await frame(host, files).getByLabel("Frame title").boundingBox())!;
      await host.mouse.move(grip.x + grip.width + 40, grip.y + 5);
      await host.mouse.down();
      await host.mouse.move(clientX, grip.y + 5, { steps: 8 });
      const from = await transform(host);
      await settle(2000);
      const held = await transform(host);
      await host.mouse.up();
      await settle();
      return { from, held };
    };
    let scrolled = await edgeDrag(board.x + board.width - 5);
    expect(scrolled.held, "the right side scrolls the row").not.toBe(scrolled.from);
    expect([
      (await at(host, files)).x,
      (await at(host, term)).x,
      (await at(host, files)).y,
    ]).toEqual([1160, 600, 0]);
    expect(await order(), "…last in the row").toEqual([draw, term, files]);
    expect(await on(), "…still full screen").toBe(true);
    scrolled = await edgeDrag(board.x + 5);
    expect(scrolled.held, "the left side scrolls it back").not.toBe(scrolled.from);
    expect(await order(), "…first in the row").toEqual([files, draw, term]);
    expect([(await at(host, files)).x, (await at(host, term)).x]).toEqual([0, 1200]);
    expect(await current(), "the view going after it").toBe(files);
  });

  let added = "";
  await test.step("+ after the terminal adds a drawing there, and goes to it", async () => {
    await host.locator("[data-fullscreen-dot]").nth(2).click();
    await settle();
    const t = (await frame(host, term).boundingBox())!;
    await host.mouse.move(t.x + t.width - 10, t.y + 100);
    await host.locator(`[data-insert=right][data-insert-anchor="${term}"]`).click();
    await host.locator("[data-insert-menu]").getByRole("button", { name: "Drawing" }).click();
    await settle();
    await expect(host.locator("[data-fullscreen-dot]")).toHaveCount(4);
    added = (await current())!;
    const there = await at(host, added);
    expect([there.type, there.x, there.y], "after the terminal").toEqual([
      "drawing",
      1200 + 560,
      0,
    ]);
  });

  await test.step("Ada changes the row: the frame we are on stays put", async () => {
    const still = async (what: string, change: () => Promise<unknown>) => {
      const was = (await frame(host, added).boundingBox())!;
      await change();
      await settle(800);
      const now = (await frame(host, added).boundingBox())!;
      expect(now.x, `${what}: the frame we are on stays put`).toBeNear(was.x, 1);
      expect(now.y).toBeNear(was.y, 1);
    };
    const columnOf = async (id: string) => (await at(host, id)).column;
    await still("Ada widens the row's first frame", async () =>
      ada("resize", { column: await columnOf(files), w: 800 }),
    );
    expect((await at(host, added)).x, "…which moved it on the board").toBe(800 + 600 + 560);
    await still("Ada moves a frame of the row into the row under it", () =>
      ada("moveFrame", draw, { anchor: web, side: "right" }),
    );
    expect(await on(), "full screen stays on the row").toBe(true);
    await expect(host.locator("[data-fullscreen-dot]"), "…without it").toHaveCount(3);
    await still("Ada moves a frame into the row, before ours", () =>
      ada("moveFrame", web, { anchor: added, side: "left" }),
    );
    expect((await at(host, added)).x).toBe(800 + 560 + 600);
    await ada("moveFrame", added, { before: null });
    await settle(800);
    expect(await on(), "Ada moves the frame we are on elsewhere: we stay on the row").toBe(true);
    expect(await current(), "…on the one before").toBe(web);
    expect(await order(), "…which is the row without it").toEqual([files, term, web]);
  });

  await test.step("the wheel pans along the row only", async () => {
    const before = await transform(host);
    await host.mouse.move(board.x + 4, board.y + board.height - 4);
    await host.mouse.wheel(0, 300);
    await settle(200);
    const after = await transform(host);
    const xy = (s: string) =>
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(s)!.slice(1).map(Number);
    expect(xy(after)[1], "not up or down").toBe(xy(before)[1]);
    expect(xy(after)[0], "along").not.toBe(xy(before)[0]);
    expect(await on(), "still full screen").toBe(true);
  });

  await test.step("zooming, F, ✕ and following end it; Esc doesn't", async () => {
    // Over a header: a browser frame's page keeps its wheel.
    await host.mouse.move(board.x + board.width / 2, board.y + 10);
    await host.keyboard.down("Control");
    await host.mouse.wheel(0, 100);
    await host.keyboard.up("Control");
    await settle();
    expect(await on(), "zooming ends it").toBe(false);
    expect(await mode(files)).toBeNull();
    await expect(
      host.locator("[data-hud]").getByTitle("Zoom in"),
      "zoom controls back",
    ).toBeVisible();
    const enter = async () => {
      await host.locator("[data-hud]").getByTitle("Fit board to view").click();
      await frame(host, files).locator("[data-fullscreen-toggle]").click();
      await settle();
      return on();
    };
    await fit(host);
    const fitted = await transform(host);
    expect(await enter(), "the header's button goes full screen").toBe(true);
    await host.keyboard.press("Escape");
    await settle();
    expect(await on(), "Esc doesn't end it: it is for leaving a field").toBe(true);
    await host.keyboard.press("f");
    await settle();
    expect(await on(), "F ends it").toBe(false);
    expect(await transform(host), "…back to the view before").toBe(fitted);
    await enter();
    await host.locator("[data-fullscreen-exit]").click();
    await settle();
    expect(await on(), "✕ ends it").toBe(false);
    expect(await transform(host), "…back to the view before too").toBe(fitted);
    await enter();
    await host.locator('header [data-avatar="Ada"]').click();
    await settle();
    expect(await on(), "following Ada ends it").toBe(false);
    await host.locator('header [data-avatar="Ada"]').click();

    await enter();
    await frame(host, files).getByTitle("Remove frame").click();
    await settle();
    expect(await on(), "closing the frame stays full screen").toBe(true);
    expect(await current(), "…on the next frame of the row").toBe(term);
    for (const id of [term, web])
      await host.evaluate((f) => (window as any).room.doc.getMap("frames").delete(f), id);
    await settle();
    expect(await on(), "removing the row's last frame ends it").toBe(false);
  });

  await test.step("on the board too, the frame we occupy stays put", async () => {
    await fit(host);
    const d = (await frame(host, draw).boundingBox())!;
    await host.mouse.click(d.x + d.width * 0.6, d.y + 10);
    await settle(300);
    const was = (await frame(host, draw).boundingBox())!;
    const drawX = (await at(host, draw)).x;
    await ada("moveFrame", added, { anchor: draw, side: "left" });
    await settle(800);
    expect((await at(host, draw)).x, "Ada adds a frame before the one we occupy").toBeGreaterThan(
      drawX,
    );
    const now = (await frame(host, draw).boundingBox())!;
    expect(now.x, "…it stays put on our screen").toBeNear(was.x, 1);
    expect(now.y).toBeNear(was.y, 1);
  });
});

test("full screen in presence, and following into it", async ({ host, guest }) => {
  await clear(host);
  const a = await add(host, "Files");
  const b = await add(host, "Drawing");
  const c = await add(host, "Drawing");
  await arrange(host, {
    [a]: { x: 0, y: 0, w: 600, h: 400 },
    [b]: { x: 600, y: 0, w: 600, h: 400 },
    [c]: { x: 1200, y: 0, w: 600, h: 400 },
  });
  // Ada's screen is smaller than Karl's.
  await guest.setViewportSize({ width: 1100, height: 720 });
  for (const page of [host, guest]) await fit(page);
  await settle();
  const on = async (page: Page) => (await page.locator("[data-fullscreen-bar]").count()) > 0;
  const current = (page: Page) =>
    page.locator("[data-fullscreen-dot][aria-current]").getAttribute("data-fullscreen-dot");
  const following = async () => (await guest.locator("[data-following-view]").count()) > 0;
  const peers = (page: Page, id: string) =>
    page.locator(`[data-fullscreen-dot="${id}"]`).getAttribute("data-fullscreen-dot-peers");

  await test.step("others see who is in full screen where", async () => {
    await frame(host, a).locator("[data-fullscreen-toggle]").click();
    await settle(600);
    expect(await on(host)).toBe(true);
    await expect(
      frame(guest, a).locator('[data-fullscreen-peer="Karl"]'),
      "on its header",
    ).toHaveCount(1);
    await expect(frame(guest, b).locator("[data-fullscreen-peer]"), "on no other").toHaveCount(0);
    await frame(guest, b).locator("[data-fullscreen-toggle]").click();
    await expect.poll(() => peers(host, b), "Karl sees Ada on b's dot").toBe("Ada");
    expect(await peers(guest, a), "…and Ada Karl on a's").toBe("Karl");
    await guest.keyboard.press("f");
    await settle(600);
    expect(await on(guest), "Ada leaves full screen").toBe(false);
    await expect.poll(() => peers(host, b), "…and her ring goes from b's dot").toBeNull();
  });

  await test.step("following Karl is full screen on his frame, at Ada's screen's size", async () => {
    await guest.locator('header [data-avatar="Karl"]').click();
    await settle(600);
    const screen = (await guest.locator("[data-board]").boundingBox())!;
    const box = (await frame(guest, a).boundingBox())!;
    expect(await on(guest), "Ada is in full screen").toBe(true);
    expect(await current(guest), "…on his frame").toBe(a);
    expect(box.height, "…as tall as her own screen").toBeNear(screen.height, 1);
    expect(box.y).toBeNear(screen.y, 1);
    expect(box.x + box.width / 2, "…in the middle of it").toBeNear(screen.x + screen.width / 2, 1);
    expect(await following(), "…still following").toBe(true);
    expect(await frame(host, a).getAttribute("data-occupant"), "…not taking his frame").toBe(
      "Karl",
    );
  });

  await test.step("he steps along, she goes with him; he leaves, so does she", async () => {
    await host.mouse.move(700, 20);
    await host.keyboard.press("l");
    await expect.poll(() => current(guest), "to b").toBe(b);
    await host.keyboard.press("l");
    await expect.poll(() => current(guest), "and to c").toBe(c);
    expect(await following()).toBe(true);
    await host.keyboard.press("f");
    await expect.poll(() => on(guest), "Karl leaves full screen: so does Ada").toBe(false);
    expect(await following(), "…still following his view").toBe(true);
  });

  await test.step("her own move ends following, and leaves her where she is", async () => {
    await frame(host, b).locator("[data-fullscreen-toggle]").click();
    await expect.poll(() => current(guest), "Karl goes full screen again: Ada too").toBe(b);
    const screen = (await guest.locator("[data-board]").boundingBox())!;
    await guest.mouse.move(screen.x + screen.width / 2, screen.y + 10);
    await guest.mouse.wheel(0, 300);
    await settle(600);
    expect(await following(), "Ada's own pan ends following").toBe(false);
    expect(await on(guest), "…and she stays in full screen, on her own").toBe(true);
    await host.keyboard.press("l");
    await settle(600);
    expect(await current(guest), "…no longer going where Karl goes").not.toBe(c);
  });
});
