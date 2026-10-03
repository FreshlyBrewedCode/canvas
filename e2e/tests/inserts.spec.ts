// Adding beside (`components/inserts.tsx`): a "+" on the vertical edge of a row
// the mouse is near, its size and reach in screen px, kept while its menu is open.
import { add, arrange, clear, fit, frame, frames, settle } from "../board";
import { expect, test } from "../fixtures";

test("a + on the edge the mouse is near", async ({ host }) => {
  await clear(host);
  // A row of two, and a cluster of its own right of it.
  const [a, b, c] = [await add(host, "Files"), await add(host, "Files"), await add(host, "Files")];
  await arrange(host, {
    [a]: { x: 0, y: 0, w: 600, h: 400 },
    [b]: { x: 624, y: 0, w: 600, h: 400 },
    [c]: { x: 2000, y: 0, w: 600, h: 400 },
  });
  await fit(host);
  const dom = async (id: string) => (await frame(host, id).boundingBox())!;
  const plus = host.locator("[data-insert]");
  const which = async () =>
    (await plus.count()) === 1
      ? `${await plus.getAttribute("data-insert-anchor")}:${await plus.getAttribute("data-insert")}`
      : null;
  const centre = async () => {
    const p = (await plus.boundingBox())!;
    return { x: p.x + p.width / 2, y: p.y + p.height / 2, size: p.width };
  };
  const hover = async (x: number, y: number) => {
    await host.mouse.move(x, y);
    await settle(100);
  };

  await test.step("near an edge, not in a frame's middle", async () => {
    const A = await dom(a);
    await hover(A.x + A.width / 2, A.y + A.height / 2);
    await expect(plus, "no + in the middle of a frame").toHaveCount(0);
    await hover(A.x + A.width - 12, A.y + A.height / 2);
    expect(await which(), "near A's right edge: a + after A").toBe(`${a}:right`);
    const at = await centre();
    expect(at.x, "…on the edge").toBeNear(A.x + A.width);
    expect(at.y, "…in its middle").toBeNear(A.y + A.height / 2);
    const B = await dom(b);
    await hover(B.x + 12, B.y + 30);
    expect(await which(), "just inside B: the same +, on the edge they share").toBe(`${a}:right`);
    await hover(A.x + 6, A.y + 30);
    expect(await which(), "near A's left edge: a + before it").toBe(`${a}:left`);
    const C = await dom(c);
    await hover(C.x - 10, C.y + 30);
    expect(await which(), "just outside a cluster: its edge's +").toBe(`${c}:left`);
    await hover(C.x + C.width / 2, C.y - 40);
    await expect(plus, "none above a frame").toHaveCount(0);
  });

  await test.step("the menu keeps its +, wherever the mouse goes on the way to it", async () => {
    const A = await dom(a);
    await host.mouse.move(A.x + A.width - 12, A.y + A.height / 2);
    await plus.click();
    const menu = host.locator("[data-insert-menu]");
    await menu.waitFor();
    const B = await dom(b);
    await host.mouse.move(B.x + 20, B.y + B.height / 2, { steps: 4 });
    await hover(B.x + B.width - 12, B.y + B.height / 2);
    expect(await which(), "over B and near its far edge: the + stays").toBe(`${a}:right`);
    await expect(menu, "…and its menu").toBeVisible();
    await menu.getByRole("button", { name: "Drawing" }).click();
    await settle(800);
    const row = (await frames(host))
      .filter((f) => f.y === 0 && f.x < 2000)
      .sort((p, q) => p.x - q.x);
    expect(
      row.map((f) => (f.id === a ? "A" : f.id === b ? "B" : f.type)),
      "Drawing goes between A and B",
    ).toEqual(["A", "drawing", "B"]);
    await hover(0, 0);
    await expect(menu, "the menu is gone").toHaveCount(0);
  });

  await test.step("the same size on screen, and as far a reach, at any zoom", async () => {
    let A = await dom(a);
    await hover(A.x + A.width - 12, A.y + 100);
    const fitted = (await centre()).size;
    for (let i = 0; i < 12; i++) await host.locator("[data-hud]").getByTitle("Zoom out").click();
    await settle(600);
    A = await dom(a);
    await hover(A.x + A.width - 2, A.y + A.height / 2);
    expect((await centre()).size, "zoomed out, the + is 24 px").toBeNear(24);
    expect(fitted, "…as when fitted").toBeNear(24);
    // Well outside the tiny frame, it is still there.
    await hover(A.x + A.width + 20, A.y + A.height / 2);
    expect(await which(), "…and it is reached from as far").not.toBeNull();
  });
});
