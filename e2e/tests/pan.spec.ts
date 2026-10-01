// Panning over frames: the middle button and Space + drag pan from anywhere,
// without the frame under the pointer hearing of it.
import { add, arrange, clear, fit, frame, settle } from "../board";
import { expect, test } from "../fixtures";

test("panning over frames", async ({ host, guest }) => {
  await clear(host);
  const term = await add(host, "Terminal");
  const web = await add(host, "Browser");
  const draw = await add(host, "Drawing");
  await arrange(host, {
    [term]: { x: 0, y: 0, w: 560, h: 380, z: 1 },
    [web]: { x: 600, y: 0, w: 560, h: 380, z: 2 },
    [draw]: { x: 0, y: 420, w: 560, h: 380, z: 3 },
  });
  await fit(host);
  await frame(host, term).locator(".xterm").waitFor({ timeout: 10_000 });
  await settle(800);

  const offset = () =>
    host.evaluate(() => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        (document.querySelector("[data-board] > div") as HTMLElement).style.transform,
      );
      return { x: Number(m?.[1]), y: Number(m?.[2]) };
    });
  /** A point inside a frame's content, a third of the way in. */
  const inside = async (id: string) => {
    const b = (await frame(host, id).boundingBox())!;
    return { x: b.x + b.width / 3, y: b.y + b.height / 2 };
  };
  /** Drag by (120, 80): how far the board moved. */
  const drag = async (at: { x: number; y: number }, button: "left" | "middle") => {
    const before = await offset();
    await host.mouse.move(at.x, at.y);
    await host.mouse.down({ button });
    await host.mouse.move(at.x + 60, at.y + 40, { steps: 5 });
    await host.mouse.move(at.x + 120, at.y + 80, { steps: 5 });
    await host.mouse.up({ button });
    await settle(300);
    const after = await offset();
    return [Math.round(after.x - before.x), Math.round(after.y - before.y)];
  };
  const panned = [120, 80];
  const still = [0, 0];
  const ready = () => host.locator("[data-board]").getAttribute("data-pan-ready");
  const board = (await host.locator("[data-board]").boundingBox())!;
  const pressBoard = () =>
    host.mouse.click(board.x + board.width - 40, board.y + board.height - 40);

  await test.step("the middle button over a terminal pans; the terminal isn't touched", async () => {
    expect(await drag(await inside(term), "middle")).toEqual(panned);
    expect(
      await frame(host, term).getAttribute("data-occupant"),
      "…without occupying it",
    ).toBeNull();
    expect(
      await host.evaluate((f) => (window as any).room.doc.getMap("frames").get(f).get("z"), term),
      "…or raising it",
    ).toBe(1);
    await settle(500);
    expect(
      await frame(guest, term).getAttribute("data-occupant"),
      "…as the guest sees too",
    ).toBeNull();
  });

  await test.step("the left button over a terminal is the terminal's, and so is Space", async () => {
    expect(await drag(await inside(term), "left")).toEqual(still);
    await frame(host, term).locator(".xterm").click();
    await host.keyboard.down("Space");
    expect(await ready(), "Space typed into a terminal").toBeNull();
    await host.keyboard.up("Space");
  });

  await test.step("off the terminal, Space + drag pans over frames", async () => {
    await pressBoard();
    await host.keyboard.down("Space");
    expect(await ready(), "holding Space readies the board").toBe("true");
    expect(
      await frame(host, term)
        .locator(".xterm-screen")
        .evaluate((el) => getComputedStyle(el).cursor),
      "…with a grab cursor over frames",
    ).toBe("grab");
    expect(await drag(await inside(term), "left"), "over a terminal").toEqual(panned);
    // Its iframe lets the press through.
    expect(await drag(await inside(web), "left"), "over a browser frame's page").toEqual(panned);
    await host.keyboard.up("Space");
    expect(await ready(), "letting go of Space ends it").toBeNull();
    expect(await drag(await inside(term), "left"), "the terminal has its left button back").toEqual(
      still,
    );
    // Leaving the window while holding Space doesn't leave the board panning.
    await host.keyboard.down("Space");
    await host.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await ready(), "leaving the window lets go of Space").toBeNull();
    await host.keyboard.up("Space");
  });

  await test.step("Space in a title field is a space; the empty board pans", async () => {
    const title = frame(host, term).getByLabel("Frame title");
    await title.click();
    await host.keyboard.press("End");
    await host.keyboard.type(" x");
    await expect(title).toHaveValue(/ x$/);
    await pressBoard();
    expect(await drag({ x: board.x + board.width - 60, y: board.y + 60 }, "left")).toEqual(panned);
  });

  await test.step("a drawing being edited keeps the middle button", async () => {
    await frame(host, draw).locator("[data-drawing]").dblclick();
    const editor = frame(host, draw).locator("[data-drawing-editor] .excalidraw");
    await editor.waitFor({ timeout: 20_000 });
    await settle(800);
    expect(await drag(await inside(draw), "middle"), "in the drawing: Excalidraw's").toEqual(still);
    expect(await drag(await inside(term), "middle"), "over a terminal: pans").toEqual(panned);
    await expect(editor, "…and the drawing is still being edited").toBeVisible();
  });
});
