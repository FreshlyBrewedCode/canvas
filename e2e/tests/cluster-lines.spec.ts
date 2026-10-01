// Lines of clusters (ADR 0010): clusters go in lines, top to bottom, and move
// between them — beside another however wide, or in a line of their own.
import type { Locator } from "@playwright/test";
import { add, arrange, at, clear, fit, frame, header, positions, settle } from "../board";
import { expect, test } from "../fixtures";

test("clusters go in lines", async ({ host }) => {
  await clear(host);
  const [a, b, c] = [await add(host, "Files"), await add(host, "Files"), await add(host, "Files")];
  // As a board from before lines: two wide clusters wrapped, c after b.
  await arrange(host, {
    [a]: { x: 0, y: 0, w: 3000, h: 400 },
    [b]: { x: 3200, y: 0, w: 3000, h: 400 },
    [c]: { x: 6400, y: 0, w: 600, h: 400 },
  });
  await fit(host);
  const where = () => positions(host, a, b, c);
  const box = async (id: string) => (await frame(host, id).boundingBox())!;
  const scale = async () => (await box(a)).width / (await at(host, a)).w;
  const grip = async (id: string) =>
    host.locator(`[data-cluster-grip="${(await at(host, id)).cluster}"] button`);
  /**
   * Press on `from`, move it by the screen offset that takes `id`'s top-left
   * to `to`, let go: the landing's box, as it showed.
   */
  const drag = async (from: Locator, id: string, to: { x: number; y: number }) => {
    const handle = (await from.boundingBox())!;
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const was = await box(id);
    await host.mouse.move(start.x, start.y);
    await host.mouse.down();
    await host.mouse.move(start.x + 20, start.y + 20, { steps: 3 });
    await host.mouse.move(start.x + to.x - was.x, start.y + to.y - was.y, { steps: 12 });
    await settle();
    const landing = host.locator("[data-drop-landing]");
    const seen = (await landing.count()) ? await landing.boundingBox() : null;
    await host.mouse.up();
    await settle();
    return seen;
  };

  await test.step("a board from before lines wraps as it did", async () => {
    const [B, C] = [await at(host, b), await at(host, c)];
    expect(B.y, await where()).toBeGreaterThan(0);
    expect(C.y).toBe(B.y);
  });

  await test.step("a cluster beside another, tops level: one line, however wide", async () => {
    const A = await box(a);
    await drag(await grip(b), b, { x: A.x + A.width + 200 * (await scale()), y: A.y });
    const [fa, fb, fc] = [await at(host, a), await at(host, b), await at(host, c)];
    expect(fb.y, await where()).toBe(fa.y);
    expect(fb.x).toBeGreaterThan(fa.x);
    expect(fc.y, "c on the line under").toBeGreaterThan(fa.y);
  });

  await test.step("a cluster above the first line: a line of its own on top", async () => {
    await fit(host);
    const A = await box(a);
    await drag(await grip(c), c, { x: A.x, y: A.y - 300 * (await scale()) });
    const [fa, fb, fc] = [await at(host, a), await at(host, b), await at(host, c)];
    expect(fc.y, await where()).toBe(0);
    expect(fa.y).toBeGreaterThan(fc.y + fc.h);
    expect(fb.y).toBe(fa.y);
  });

  await test.step("a frame below the last line: a new cluster, a line of its own", async () => {
    await fit(host);
    const B = await box(b);
    const bar = await drag(header(host, b), b, {
      x: B.x,
      y: B.y + B.height + 400 * (await scale()),
    });
    expect(bar, "a bar across marks the new line").not.toBeNull();
    expect(bar!.height).toBeLessThan(20);
    expect(bar!.width).toBeGreaterThan(100);
    const [ga, gb] = [await at(host, a), await at(host, b)];
    expect(gb.y, await where()).toBeGreaterThan(ga.y + ga.h);
    expect(gb.x).toBe(0);
  });
});
