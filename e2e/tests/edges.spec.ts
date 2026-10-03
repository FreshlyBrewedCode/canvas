// Edges (ADR 0010): frames of a cluster share their borders, and every edge
// resizes — a vertical one its column's width, a horizontal one its row's
// height, a corner both. In full screen, widths, and a terminal's own height.
import { add, arrange, at, clear, fit, frame, settle } from "../board";
import { expect, test } from "../fixtures";

test("every edge resizes", async ({ host, guest }) => {
  await clear(host);
  const [a, b, c] = [
    await add(host, "Files"),
    await add(host, "Drawing"),
    await add(host, "Files"),
  ];
  await arrange(host, {
    [a]: { x: 0, y: 0, w: 600, h: 400 },
    [b]: { x: 624, y: 0, w: 600, h: 400 },
    [c]: { x: 0, y: 424, w: 600, h: 300 },
  });
  await fit(host);
  const dom = async (id: string) => (await frame(host, id).boundingBox())!;
  /** Press at a client point, move by board (dx, dy), let go. */
  const pull = async (x: number, y: number, dx: number, dy: number) => {
    await host.mouse.move(x, y);
    await host.mouse.down();
    const s = (await dom(a)).width / (await at(host, a)).w;
    await host.mouse.move(x + (dx * s) / 2, y + (dy * s) / 2, { steps: 4 });
    await host.mouse.move(x + dx * s, y + dy * s, { steps: 4 });
    await host.mouse.up();
    await settle();
  };

  await test.step("frames of a cluster share their borders", async () => {
    const [A, B, C] = [await at(host, a), await at(host, b), await at(host, c)];
    expect(B.x, "no gap between A and B").toBe(A.x + A.w);
    expect(C.y, "no gap between the rows").toBe(A.y + A.h);
    await expect(
      host.locator("[data-frame] .cursor-nwse-resize"),
      "no corner handle in frames",
    ).toHaveCount(0);
  });

  await test.step("the vertical edge A and B share: A wider, B along", async () => {
    const box = await dom(a);
    // Off its middle: that is where the "+" is.
    await pull(box.x + box.width, box.y + box.height / 3, 100, 0);
    const [A, B] = [await at(host, a), await at(host, b)];
    expect([A.w, B.x, B.w]).toEqual([700, 700, 600]);
  });

  await test.step("the edge between the rows: the first row taller, C down", async () => {
    const box = await dom(b);
    await pull(box.x + box.width / 2, box.y + box.height, 0, 80);
    const [A, B, C] = [await at(host, a), await at(host, b), await at(host, c)];
    expect([A.h, B.h, C.y]).toEqual([480, 480, 480]);
  });

  await test.step("a corner: both", async () => {
    // Fitted again: the taller row pushed C down.
    await fit(host);
    const box = await dom(c);
    await pull(box.x + box.width, box.y + box.height, 50, 40);
    const C = await at(host, c);
    expect([C.w, C.h]).toEqual([650, 340]);
    await expect(frame(guest, c), "the guest sees it").toHaveAttribute("style", /width: 650px/);
  });

  await test.step("full screen: widths, and a terminal's own height", async () => {
    const t = await add(host, "Terminal");
    await arrange(host, {
      [a]: { x: 0, y: 0, w: 700, h: 480 },
      [b]: { x: 700, y: 0, w: 600, h: 480 },
      [t]: { x: 1300, y: 0, w: 560, h: 480 },
      [c]: { x: 0, y: 480, w: 650, h: 340 },
    });
    await fit(host);
    await frame(host, a).locator("[data-fullscreen-toggle]").click();
    await settle(800);
    const screen = (await host.locator("[data-board]").boundingBox())!;
    await expect(
      host.locator("[data-edge=horizontal]"),
      "only the terminal's bottom edge is horizontal",
    ).toHaveCount(1);
    const before = (await at(host, a)).w;
    let box = await dom(a);
    await pull(box.x + box.width, box.y + 300, -120, 0);
    expect((await at(host, a)).w, "a vertical edge sets widths").toBe(before - 120);
    await host.locator(`[data-fullscreen-dot="${t}"]`).click();
    await settle(800);
    box = await dom(t);
    expect(box.height, "the terminal is half the screen tall").toBeNear(screen.height / 2);
    await pull(box.x + box.width / 2, box.y + box.height, 0, 150);
    const height: number = (await at(host, t)).height;
    expect(height, "its bottom edge sets its height").toBeNear(screen.height / 2 + 150);
    expect((await dom(t)).height).toBeNear(height);

    // The guest's full screen shows the host's height.
    await frame(guest, t).locator("[data-fullscreen-toggle]").click();
    await settle(800);
    expect(
      (await frame(guest, t).boundingBox())!.height,
      "the guest sees the host's height",
    ).toBeNear(height);
    await guest.keyboard.press("f");

    // "+" sits on the edge the frame shares with the one before.
    box = await dom(t);
    await host.mouse.move(box.x + 10, box.y + 60);
    await expect(host.locator("[data-insert]"), "one + near the edge").toHaveCount(1);
    const plus = (await host
      .locator(`[data-insert=right][data-insert-anchor="${b}"]`)
      .boundingBox())!;
    expect(plus.x + plus.width / 2, "…on the edge it shares with the one before").toBeNear(box.x);
  });
});
