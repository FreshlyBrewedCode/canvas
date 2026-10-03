// A file frame's tree panel follows its occupant: open or closed, its width,
// its folders, search and scroll (finding 18).
import type { Page } from "@playwright/test";
import { add, arrange, clear, fit, frame, settle } from "../board";
import { expect, test } from "../fixtures";

test("the tree panel follows its occupant", async ({ host, guest }) => {
  await clear(host);
  const a = await add(host, "Files");
  await arrange(host, {
    [a]: { path: "README.md", title: "README.md", x: 0, y: 0, w: 900, h: 600 },
  });
  for (const page of [host, guest]) {
    await expect(frame(page, a).getByText("A small project")).toBeVisible({ timeout: 10_000 });
    await fit(page);
  }

  /** The tree panel as a viewer sees it; null when closed. */
  const tree = (page: Page) =>
    frame(page, a).evaluate((el) => {
      const toolbar = el.querySelector("[data-tree-toolbar]");
      if (!toolbar) return null;
      const view = [...el.querySelectorAll("*")].find((node) =>
        node.shadowRoot?.querySelector("[data-file-tree-virtualized-scroll]"),
      )!.shadowRoot!;
      const scroller = view.querySelector("[data-file-tree-virtualized-scroll]")!;
      const rows = view.querySelectorAll<HTMLElement>(
        '[aria-expanded="true"][data-item-path]:not([data-file-tree-sticky-row])',
      );
      const input = view.querySelector<HTMLInputElement>("[data-file-tree-search-input]");
      const panel = toolbar.parentElement!.getBoundingClientRect().width;
      return {
        expanded: [...new Set([...rows].map((row) => row.dataset.itemPath!))].sort().join(" "),
        top: Math.round(scroller.scrollTop),
        search: input?.value ?? "",
        width: Math.round((100 * panel) / el.getBoundingClientRect().width),
      };
    });
  const following = (page: Page) =>
    frame(page, a).evaluate((el) => el.hasAttribute("data-following"));
  const row = (page: Page, path: string) =>
    frame(page, a).locator(`[data-item-path="${path}"]:not([data-file-tree-sticky-row])`).first();
  /** The guest's tree comes to be the host's; what it is. */
  const same = async (what: string) => {
    await expect
      .poll(async () => JSON.stringify(await tree(guest)), { message: what })
      .toBe(JSON.stringify(await tree(host)));
    return tree(host);
  };

  let opened: Awaited<ReturnType<typeof tree>> = null;
  await test.step("open and closed, with the occupant's", async () => {
    expect(await tree(guest), "a new files frame opens with its tree").not.toBeNull();
    // Pressing A claims it.
    await frame(host, a).getByTitle("Hide files").click();
    await expect.poll(() => following(guest), "the guest follows Karl in A").toBe(true);
    await expect.poll(() => tree(guest), "the guest's tree closes with Karl's").toBeNull();
    await frame(host, a).getByTitle("Show files").click();
    await expect.poll(() => tree(host)).not.toBeNull();
    opened = await same("the guest's tree opens with Karl's, as wide");
  });

  await test.step("folders, scroll, search", async () => {
    for (const path of ["src/", "src/alpha/", "src/alpha/two/", "src/gamma/", "src/gamma/three/"]) {
      await row(host, path).click();
      await settle(250);
    }
    const folders = await same("the guest's folders follow Karl's");
    expect(folders?.expanded).toContain("src/gamma/three/");

    const at = (await row(host, "src/").boundingBox())!;
    await host.mouse.move(at.x + 20, at.y + 5);
    await host.mouse.wheel(0, 300);
    await expect.poll(async () => (await tree(host))?.top).toBeGreaterThan(0);
    await same("the guest's tree scrolls with Karl's");

    await host.mouse.wheel(0, -1000);
    await settle(300);
    await row(host, "src/alpha/").click();
    await expect.poll(async () => (await tree(host))?.expanded).not.toContain("src/alpha/two/");
    await same("the guest's folder closes with Karl's");

    const search = frame(host, a).locator("[data-file-tree-search-input]");
    await search.click();
    await search.fill("f7");
    await expect.poll(async () => (await tree(host))?.search).toBe("f7");
    await same("the guest searches what Karl searches");
    await search.fill("");
    await host.keyboard.press("Escape");
    await settle();
  });

  await test.step("a guest opening a folder themselves is detached", async () => {
    await row(guest, "src/beta/").click();
    await expect.poll(() => following(guest), "opening a folder stops following").toBe(false);
    await row(host, "src/gamma/").click();
    await settle(800);
    const [h, g] = [await tree(host), await tree(guest)];
    expect(g?.expanded, "the detached guest keeps their own folders").toContain("src/beta/");
    expect(g?.expanded).toContain("src/gamma/");
    expect(h?.expanded).not.toContain("src/gamma/");

    await frame(guest, a).locator("[data-occupant-badge]").click();
    await expect.poll(() => following(guest), "a badge click follows again").toBe(true);
    await same("the guest's tree is Karl's again");
  });

  await test.step("the panel's width, and closing it", async () => {
    const handle = frame(host, a).locator('[data-slot="resizable-handle"]');
    const hb = (await handle.boundingBox())!;
    await host.mouse.move(hb.x + 1, hb.y + hb.height / 2);
    await host.mouse.down();
    await host.mouse.move(hb.x + 120, hb.y + hb.height / 2, { steps: 8 });
    await host.mouse.up();
    await expect.poll(async () => (await tree(host))?.width).toBeGreaterThan(opened!.width);
    await same("the guest's panel widens with Karl's");
    await frame(host, a).getByTitle("Hide files").click();
    await expect.poll(() => tree(guest), "the guest's tree closes with Karl's").toBeNull();
  });
});
