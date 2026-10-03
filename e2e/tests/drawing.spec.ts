// Drawing frames (ADR 0009, finding 17): Excalidraw under the board's zoom,
// host and guest drawing into one drawing at once, undo that stays yours,
// view guests.
import type { Page } from "@playwright/test";
import { add, arrange, clear, fit, frame, settle } from "../board";
import { expect, test } from "../fixtures";
import { setRole } from "../members";

const elements = (p: Page, id: string) =>
  p.evaluate(
    (frameId) =>
      [...(window as any).room.doc.getMap(`drawing:${frameId}`).values()].filter(
        (e: any) => !e.isDeleted,
      ),
    id,
  ) as Promise<Array<Record<string, any>>>;
const types = async (p: Page, id: string) => (await elements(p, id)).map((e) => e.type).sort();

const scale = async (p: Page) =>
  Number(
    await p
      .locator("[data-board]")
      .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--board-scale")),
  );

const drag = async (p: Page, x0: number, y0: number, x1: number, y1: number) => {
  await p.mouse.move(x0, y0);
  await p.mouse.down();
  await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
  await p.mouse.move(x1, y1, { steps: 6 });
  await p.mouse.up();
};

test("drawing together", async ({ host, guest }) => {
  test.setTimeout(90_000);
  await clear(host);
  const id = await add(host, "Drawing");
  await arrange(host, { [id]: { x: 0, y: 0 } });
  await fit(host);
  await fit(guest);
  // Not 100%: Excalidraw must draw under the board's zoom.
  await host.locator("[data-hud]").getByTitle("Zoom out").click();
  await settle();
  const s = await scale(host);
  await expect(frame(guest, id).getByText("Double-click to draw.")).toBeVisible({
    timeout: 10_000,
  });

  await test.step("the host draws a rectangle where the pointer goes, at any zoom", async () => {
    await frame(host, id)
      .locator("[data-drawing]")
      .dblclick({ position: { x: 20, y: 300 } });
    await frame(host, id).locator("[data-drawing-editor] .excalidraw").waitFor({ timeout: 20_000 });
    await settle(800);
    const box = (await frame(host, id).locator("[data-drawing-editor]").boundingBox())!;
    await host.mouse.click(box.x + box.width - 60, box.y + box.height - 120);
    await host.keyboard.press("r");
    // Right of the style panel, which opens on the left with a tool.
    await drag(host, box.x + 260, box.y + 140, box.x + 460, box.y + 300);
    await expect.poll(() => types(host, id)).toContain("rectangle");
    const rect = (await elements(host, id)).find((e) => e.type === "rectangle")!;
    expect(Number(rect.width), `200 screen px wide at ${Math.round(s * 100)}%`).toBeNear(
      200 / s,
      3,
    );
    expect(Number(rect.height)).toBeNear(160 / s, 3);
    expect(Number(rect.x)).toBeNear(260 / s, 3);
    await guest.waitForFunction(
      (frameId) =>
        document.querySelector(`[data-frame="${frameId}"] [data-drawing-picture] svg path`),
      id,
      { timeout: 10_000 },
    );
    await expect
      .poll(
        async () => (await elements(guest, id)).find((e) => e.type === "rectangle")?.width,
        "the guest has it, at its final size",
      )
      .toBe(rect.width);
  });

  await test.step("the guest draws too, while the host still is", async () => {
    await frame(guest, id).locator("[data-drawing-edit]").click();
    await frame(guest, id)
      .locator("[data-drawing-editor] .excalidraw")
      .waitFor({ timeout: 20_000 });
    await settle(800);
    const box = (await frame(guest, id).locator("[data-drawing-editor]").boundingBox())!;
    await guest.mouse.click(box.x + box.width - 60, box.y + box.height - 120);
    await guest.keyboard.press("o");
    await drag(guest, box.x + 560, box.y + 120, box.x + 720, box.y + 240);
    await expect
      .poll(() => types(host, id), "the guest's ellipse reaches the host")
      .toContain("ellipse");
  });

  await test.step("undo is your own", async () => {
    await host.keyboard.press("Control+z");
    await expect
      .poll(() => types(guest, id), "undo takes back the host's rectangle only")
      .toEqual(["ellipse"]);
    await host.keyboard.press("Control+Shift+z");
    await expect
      .poll(() => types(guest, id), "redo brings it back")
      .toEqual(["ellipse", "rectangle"]);
  });

  await test.step("a click outside ends editing; the picture zooms with the board", async () => {
    const picture = async () =>
      (await frame(host, id).locator("[data-drawing-picture]").boundingBox())!.width;
    await host.mouse.click(5, 300);
    await frame(guest, id).locator('[data-drawing-edit="done"]').click();
    await frame(host, id).locator("[data-drawing-picture] svg").waitFor({ timeout: 10_000 });
    await expect(host.locator("[data-drawing-editor]")).toHaveCount(0);
    const [before, k] = [await picture(), await scale(host)];
    await host.locator("[data-hud]").getByTitle("Zoom in").click();
    await settle(600);
    const zoomed = (await scale(host)) / k;
    expect(zoomed, "the board zoomed in").toBeGreaterThan(1);
    expect((await picture()) / before, "the picture zooms as much").toBeNear(zoomed, 0.02);
  });

  await test.step("view guests look, but don't draw", async () => {
    await setRole(host, guest, "view");
    await expect(frame(guest, id).locator("[data-drawing-edit]"), "no Edit").toHaveCount(0, {
      timeout: 5000,
    });
    await frame(guest, id).locator("[data-drawing]").dblclick();
    await settle(800);
    await expect(
      guest.locator("[data-drawing-editor]"),
      "nor an editor on double-click",
    ).toHaveCount(0);
    await setRole(host, guest, "edit");
  });

  await test.step("removing the frame clears its drawing", async () => {
    await frame(host, id).getByTitle("Remove frame").click();
    await expect.poll(async () => (await elements(host, id)).length).toBe(0);
  });
});
