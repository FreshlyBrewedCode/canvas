// Arranging frames (ADR 0010): drops go by the pointer — a frame's left or
// right edge into its row, its top or bottom edge a new row, elsewhere a
// cluster of its own — the others make room while it goes, the guest sees a
// ghost, a frame leaving closes its gap, clusters move by their grip or with
// Shift, Alt makes a cluster even over frames. The title field is only as wide
// as the title.
import type { Locator, Page } from "@playwright/test";
import { add, arrange, at, clear, client, fit, frame, header, positions, settle } from "../board";
import { expect, test } from "../fixtures";

const box = (x: number, y: number) => ({ x, y, w: 600, h: 400 });

test("frames go where the pointer drops them", async ({ host, guest }) => {
  await clear(host);
  const [a, b, c, d] = [
    await add(host, "Files"),
    await add(host, "Files"),
    await add(host, "Files"),
    await add(host, "Files"),
  ];
  await arrange(host, { [a]: box(0, 0), [b]: box(624, 0), [c]: box(1248, 0), [d]: box(0, 424) });
  await fit(host);
  const drag = dragger(host, guest);
  const where = (...ids: string[]) => positions(host, ...ids);

  await test.step("into a row: the others make room, the guest sees a ghost", async () => {
    // D (alone in the second row) over A's right edge: between A and B.
    const before = (await frame(host, b).boundingBox())!;
    const seen = await drag(header(host, d), 590, 200, { watch: [b] });
    expect(seen.landing, "the landing shows where it goes").toBe(true);
    expect(seen.boxes[0]!.x, "B makes room while it goes").toBeGreaterThan(before.x + 100);
    expect(seen.ghost, "the guest sees a ghost of the drag").toBe(1);
    expect(await where(a, d, b, c), "the row reads A D B C, no gaps").toBe(
      "0,0 600,0 1200,0 1800,0",
    );
    await expect(guest.locator("[data-drag-ghost]"), "…the ghost gone after the drop").toHaveCount(
      0,
    );
  });

  await test.step("to the row's end: the others close up behind it", async () => {
    await drag(header(host, d), 1200 + 590, 200);
    expect(await where(a, b, c, d)).toBe("0,0 600,0 1200,0 1800,0");
  });

  const e = await add(host, "Files");
  await test.step("over a frame's bottom edge: a row of its own between", async () => {
    await arrange(host, {
      [a]: box(0, 0),
      [b]: box(624, 0),
      [c]: box(1248, 0),
      [d]: box(1872, 0),
      [e]: box(0, 424),
    });
    await fit(host);
    await drag(header(host, d), 300, 390);
    expect(await where(a, b, c, d, e), "D a row of its own, E pushed down").toBe(
      "0,0 600,0 1200,0 0,400 0,800",
    );
  });

  await test.step("a frame leaving closes its gap", async () => {
    await frame(host, b).getByTitle("Remove frame").click();
    await expect.poll(() => where(c), "B removed, C moved into its place").toBe("600,0");
    await frame(host, d).getByTitle("Remove frame").click();
    await expect.poll(() => where(e), "D removed, E's row moved up").toBe("0,400");
  });

  const far = await add(host, "Files");
  await test.step("into another cluster's row", async () => {
    await fit(host);
    expect((await at(host, far)).cluster, "a new frame from the toolbar: its own cluster").not.toBe(
      (await at(host, c)).cluster,
    );
    await drag(header(host, a), { over: far, u: 0.95, v: 0.5 }, 0);
    const F = await at(host, far);
    expect(await where(a, c), "A beside far, C at the row's start").toBe(`${F.x + F.w},${F.y} 0,0`);
    expect((await at(host, a)).cluster, "…in far's cluster").toBe(F.cluster);
  });

  await test.step("a cluster by its grip, or with Shift", async () => {
    await fit(host);
    const first = (await at(host, c)).cluster;
    const seen = await drag(
      host.locator(`[data-cluster-grip="${(await at(host, far)).cluster}"] button`),
      -200,
      100,
    );
    expect(seen.landing, "a cluster's grip drags it, its landing shown").toBe(true);
    expect((await at(host, far)).x, "…to before the first cluster").toBe(0);
    expect((await at(host, c)).cluster).toBe(first);
    expect((await at(host, c)).x).toBeGreaterThan(0);

    await fit(host);
    await drag(header(host, c), -200, 100, { key: "Shift" });
    expect((await at(host, c)).x, "Shift moves C's cluster first").toBe(0);
    expect((await at(host, e)).x).toBe(0);
  });

  await test.step("Alt over a frame: a cluster of its own there", async () => {
    await fit(host);
    await drag(header(host, e), { over: far, u: 0.95, v: 0.5 }, 0, { key: "Alt" });
    const [E, F, C] = [await at(host, e), await at(host, far), await at(host, c)];
    expect(E.cluster).not.toBe(F.cluster);
    expect(E.cluster).not.toBe(C.cluster);
  });

  await test.step("along a row by the header, it stays in the row", async () => {
    // The pointer goes only sideways: over a frame's top, but the frame's
    // middle is in the row.
    await arrange(host, {
      [a]: box(0, 0),
      [c]: box(624, 0),
      [far]: box(1248, 0),
      [e]: box(2400, 0),
    });
    await fit(host);
    const grabbed = (await header(host, a).boundingBox())!;
    const hold = { x: grabbed.x + grabbed.width * 0.6, y: grabbed.y + grabbed.height / 2 };
    await host.mouse.move(hold.x, hold.y);
    await host.mouse.down();
    // Over the right half of the last frame, once the row closes up behind the lifted one.
    const past = await client(host, 600 + 600 * 0.8, 0);
    await host.mouse.move(past.x, hold.y, { steps: 12 });
    await settle();
    await host.mouse.up();
    await settle();
    expect(await where(c, far, a)).toBe("0,0 600,0 1200,0");
  });

  await test.step("into a new cluster between two: the clusters hold still, a bar marks the gap", async () => {
    const eBefore = (await frame(host, e).boundingBox())!;
    const seen = await drag(header(host, c), (await at(host, e)).x - 60, 200, { watch: [e] });
    expect(seen.boxes[0]!.x, "the next cluster holds still while a frame goes").toBeNear(
      eBefore.x,
      1,
    );
    expect(seen.boxes[0]!.y).toBeNear(eBefore.y, 1);
    expect(seen.bar?.width, "a bar marks the new cluster's gap").toBeLessThan(20);
    const C = await at(host, c);
    expect(C.cluster, "…and it lands a cluster of its own").not.toBe((await at(host, a)).cluster);
    expect(C.cluster).not.toBe((await at(host, e)).cluster);
  });

  await test.step("a cluster's name, for everyone", async () => {
    const cluster = (await at(host, far)).cluster;
    await host.locator(`[data-cluster-grip="${cluster}"] input`).fill("review");
    await expect(guest.locator(`[data-cluster-grip="${cluster}"] input`)).toHaveValue("review");
  });

  await test.step("the title field is as wide as the title; the header beside it drags", async () => {
    await fit(host);
    const input = frame(host, c).getByLabel("Frame title");
    const [hb, ib] = [(await header(host, c).boundingBox())!, (await input.boundingBox())!];
    expect(ib.width, "the title is a third of the header at most").toBeLessThan(hb.width / 3);
    const was = (await frame(host, c).boundingBox())!;
    const grab = { x: ib.x + ib.width + (hb.width - ib.width) / 3, y: hb.y + hb.height / 2 };
    await host.mouse.move(grab.x, grab.y);
    await host.mouse.down();
    await host.mouse.move(grab.x, grab.y - 60, { steps: 5 });
    await settle(200);
    const during = (await frame(host, c).boundingBox())!;
    await host.keyboard.press("Escape");
    await host.mouse.up();
    await settle();
    expect(during.y, "dragged by the header's empty part").toBeLessThan(was.y - 40);
    expect((await frame(host, c).boundingBox())!.y, "Esc calls a drag off").toBeNear(was.y, 1);
    await input.click();
    await expect(input, "clicking the title edits it").toBeFocused();
  });
});

/**
 * Press on `from`, move the dragged frame's middle — the pointer, for a
 * cluster — to board (x, y) — or, as a person aims, into a frame where it
 * shows once the drag is on (`over`, at fractions of its box) — look, let go:
 * whether the landing showed, its bar, the boxes of `watch` while it went, and
 * how many ghosts the guest saw.
 */
function dragger(host: Page, guest: Page) {
  /** The box of the frame a header is of; null for a cluster's grip. */
  const framed = async (from: Locator) => {
    const of = from.locator("xpath=ancestor::*[@data-frame][1]");
    return (await of.count()) ? await of.boundingBox() : null;
  };
  return async (
    from: Locator,
    x: number | { over: string; u: number; v: number },
    y: number,
    { key, watch = [] }: { key?: "Shift" | "Alt"; watch?: string[] } = {},
  ) => {
    const grip = (await from.boundingBox())!;
    // A header's empty part, right of its title; a grip's middle.
    const start = {
      x: grip.x + grip.width * (grip.width > 100 ? 0.6 : 0.5),
      y: grip.y + grip.height / 2,
    };
    await host.mouse.move(start.x, start.y);
    if (key) await host.keyboard.down(key);
    await host.mouse.down();
    await host.mouse.move(start.x + 30, start.y + 30, { steps: 3 });
    await settle(250);
    let aim;
    if (typeof x === "object") {
      const over = (await frame(host, x.over).boundingBox())!;
      aim = { x: over.x + over.width * x.u, y: over.y + over.height * x.v };
    } else aim = await client(host, x, y);
    // A frame hits by its middle's height: the point aimed at is where its middle goes.
    const dragged = key === "Shift" ? null : await framed(from);
    const to = dragged ? { ...aim, y: aim.y - (dragged.y + dragged.height / 2 - start.y) } : aim;
    await host.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 5 });
    await host.mouse.move(to.x, to.y, { steps: 5 });
    await settle();
    const landing = await host.locator("[data-drop-landing]").isVisible();
    const bar = landing ? await host.locator("[data-drop-landing]").boundingBox() : null;
    const boxes = await Promise.all(
      watch.map(async (id) => (await frame(host, id).boundingBox())!),
    );
    const ghost = await guest.locator("[data-drag-ghost]").count();
    await host.mouse.up();
    if (key) await host.keyboard.up(key);
    await settle();
    return { landing, bar, boxes, ghost };
  };
}
