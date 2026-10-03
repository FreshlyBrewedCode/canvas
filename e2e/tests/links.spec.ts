// Links to places on the board (ADR 0007, finding 14): chips in markdown,
// lines and headings for the one who clicks, Back, web links in a new tab,
// linked HTML pages in one frame, a page's own posts ignored, a guest's deep link.
import type { Page } from "@playwright/test";
import { clear, fit, frame, frames, settle } from "../board";
import { expect, test } from "../fixtures";

test.use({ project: "links" });

const presence = (p: Page) =>
  p.evaluate(() => (window as any).room.awareness.getLocalState() as any);

test("links go to places on the board", async ({ host, guest, guestLink }) => {
  await clear(host);
  await host.evaluate(() => {
    const all = (window as any).room.doc.getMap("frames");
    const readme = new all.constructor();
    const fields = {
      type: "file",
      path: "README.md",
      title: "README.md",
      x: 40,
      y: 40,
      w: 640,
      h: 560,
      z: 1,
    };
    for (const [k, v] of Object.entries(fields)) readme.set(k, v);
    all.set("readme01", readme);
  });
  const readme = frame(host, "readme01");
  const chip = (text: string) => readme.locator("[data-board-link]", { hasText: text });
  const scrolled = () => readme.locator("[data-frame-body]").evaluate((e) => e.scrollTop);
  let a: string | undefined;

  await test.step("inline code naming a file is a chip; other code stays code", async () => {
    await chip("a.ts:120-125").waitFor({ timeout: 15_000 });
    expect(await readme.locator("[data-board-link]").allInnerTexts()).toContain("src/b.ts:40");
    const codes = await readme.locator("code").allInnerTexts();
    expect(codes).toContain("foo.bar");
    expect(codes).toContain("src/nope.ts:3");
  });

  await test.step("lines: a frame beside, the lines my selection", async () => {
    const secrets = new URL(host.url()).hash;
    await chip("a.ts:120-125").click();
    await expect
      .poll(async () => (await frames(host)).find((f) => f.path === "src/a.ts"))
      .toBeTruthy();
    await settle(800);
    const opened = (await frames(host)).find((f) => f.path === "src/a.ts")!;
    a = opened.id;
    expect(opened.view, "it opens in source").toBe("source");
    expect(opened.lines, "no shared lines").toBeFalsy();
    const mine = await presence(host);
    expect([mine.selection?.start, mine.selection?.end], "the lines are my selection").toEqual([
      120, 125,
    ]);
    expect(mine.focus?.frameId, "and I occupy the frame").toBe(a);
    expect(new URL(host.url()).hash.startsWith(secrets), "the URL keeps the room's secrets").toBe(
      true,
    );
    await fit(host);
  });

  await test.step("headings, here and in another file; Back", async () => {
    await chip("Bottom").click();
    await expect.poll(scrolled, "a heading of the same file scrolls to it").toBeGreaterThan(0);
    await readme.locator("[data-frame-body]").evaluate((e) => (e.scrollTop = 0));
    await fit(host);
    await chip("Install").click();
    await expect
      .poll(async () => (await frames(host)).find((f) => f.path === "docs/guide.md"))
      .toBeTruthy();
    const guide = (await frames(host)).find((f) => f.path === "docs/guide.md")!;
    await expect
      .poll(() =>
        frame(host, guide.id)
          .locator("[data-frame-body]")
          .evaluate((e) => e.scrollTop),
      )
      .toBeGreaterThan(0);
    await host.goBack();
    await expect.poll(scrolled, "Back goes to the heading before").toBeGreaterThan(0);
  });

  await test.step("a web link opens a tab; the board stays", async () => {
    await fit(host);
    // No network in the test: the tab opening is what counts.
    await host
      .context()
      .route("https://example.com/**", (route) => route.fulfill({ body: "example" }));
    const [tab] = await Promise.all([
      host.context().waitForEvent("page", { timeout: 5000 }),
      readme.locator("a", { hasText: "example" }).click(),
    ]);
    expect(new URL(host.url()).pathname).toBe("/");
    await tab.close();
  });

  await test.step("linked HTML pages, in one frame", async () => {
    await fit(host);
    await chip("index").click();
    // The page's own post and click go out meanwhile.
    await settle(2500);
    const page = (await frames(host)).find((f) => f.path === "pages/index.html")!;
    expect(
      (await frames(host)).some((f) => f.path === "src/b.ts"),
      "the page's own posts go nowhere",
    ).toBe(false);
    const doc = frame(host, page.id).locator("iframe").contentFrame();
    await doc.locator("#two").click();
    await expect
      .poll(
        async () => (await frames(host)).find((f) => f.id === page.id)?.path,
        "a page's link opens in its frame",
      )
      .toBe("pages/two.html");
    await doc.locator("#one").click();
    await settle(2500);
    expect((await presence(host)).focus?.frameId, "nor right after a click").toBe(page.id);
    await doc.locator("#anchor").click();
    await settle();
    await expect(doc.locator("#down"), "an in-page anchor stays in the page").toHaveCount(1);
    await doc.locator("body").evaluate(() => scrollTo(0, 0));
    await doc.locator("#code").click();
    await expect
      .poll(async () => (await presence(host)).selection?.start, "a page's link to lines")
      .toBe(60);
  });

  await test.step("a guest's deep link to lines", async () => {
    const u = new URL(guestLink);
    await guest.goto(
      `${u.origin}/?room=${u.searchParams.get("room")}${u.hash}&frame=${a}&lines=30-33`,
    );
    await expect(guest.getByText("host online")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => {
        const theirs = await presence(guest);
        return [theirs.selection?.start, theirs.selection?.end];
      })
      .toEqual([30, 33]);
  });
});
