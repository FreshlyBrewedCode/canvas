/**
 * The board as tests see it: through the UI where a person would, through the
 * hooks the dev build puts on `window` (`src/web/app.tsx`) where a test only
 * sets the stage or reads what the layout derived (ADR 0010).
 */
import type { Page } from "@playwright/test";

/** A frame as `allFrames` derives it: its fields and its rect. */
export type Frame = Record<string, any> & {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const frame = (page: Page, id: string) => page.locator(`[data-frame="${id}"]`);

/** The board's frames, with their rects. */
export const frames = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => (window as any).frames());

/** One frame's fields and rect. */
export const at = async (page: Page, id: string): Promise<Frame> =>
  (await frames(page)).find((f) => f.id === id)!;

/** The frame we occupy. */
export const mine = (page: Page): Promise<string | null> =>
  page.evaluate(() => (window as any).room.ownFrame());

/** An empty board. */
export async function clear(page: Page) {
  await page.evaluate(() => {
    const all = (window as any).room.doc.getMap("frames");
    for (const id of [...all.keys()]) all.delete(id);
  });
}

/**
 * Add a frame from the toolbar and return its id. Frames render in a stable
 * order, not creation order, so the new one is found by its id.
 */
export async function add(page: Page, button: string): Promise<string> {
  const ids = () =>
    page
      .locator("[data-frame]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-frame")!));
  const before = new Set(await ids());
  await page.locator("[data-hud]").getByRole("button", { name: button }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-frame]").length > n,
    before.size,
  );
  return (await ids()).find((id) => !before.has(id))!;
}

/**
 * Change frames' fields, as one change. With x and y a frame leaves its place
 * in the tree and the host reads it back in by position, as it migrates boards
 * from before the tree (ADR 0010), so all of them are read as one board.
 */
export async function arrange(page: Page, patches: Record<string, Record<string, unknown>>) {
  await page.evaluate((all) => {
    const { doc } = (window as any).room;
    const now = new Map((window as any).frames().map((f: any) => [f.id, f]));
    doc.transact(() => {
      for (const [frameId, p] of Object.entries(all)) {
        const map = doc.getMap("frames").get(frameId);
        const { w, h } = now.get(frameId) as any;
        const fields = "x" in p ? { w, h, ...p } : p;
        if ("x" in p) for (const key of ["parent", "pos", "cluster"]) map.delete(key);
        for (const [k, v] of Object.entries(fields)) map.set(k, v);
      }
    });
  }, patches);
  // The host's tidy runs a moment after a change.
  await settle(500);
}

/** Fit the board to the view, and let it glide there. */
export async function fit(page: Page) {
  await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle(600);
}

/** The board's transform: where the view is, at what zoom. */
export const transform = (page: Page) =>
  page.evaluate(
    () => (document.querySelector("[data-board] > div") as HTMLElement).style.transform,
  );

/** For what moves in time — a glide, the host's tidy, presence — rather than a state to wait for. */
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Where a board point is on the page's screen. */
export const client = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([bx, by]) => {
      const board = document.querySelector("[data-board]")!.getBoundingClientRect();
      const t = (document.querySelector("[data-board] > div") as HTMLElement).style.transform;
      const [tx, ty, k] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/
        .exec(t)!
        .slice(1)
        .map(Number) as [number, number, number];
      return { x: board.left + tx + bx * k, y: board.top + ty + by * k };
    },
    [x, y] as const,
  );

/** A frame's header: what drags it. */
export const header = (page: Page, id: string) => frame(page, id).locator("> div").first();

/** Where frames are, as "x,y x,y …", to compare a whole arrangement at once. */
export const positions = async (page: Page, ...ids: string[]) => {
  const all = await frames(page);
  return ids
    .map((id) => all.find((f) => f.id === id))
    .map((f) => (f ? `${f.x},${f.y}` : "gone"))
    .join(" ");
};
