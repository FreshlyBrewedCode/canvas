// Comments on a file frame (ADR 0006, finding 13): people write them from the
// gutter, they stay with the frame, follow their lines as the file changes,
// and only their author or the host changes them.
import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { add, arrange, clear, frame, frames, settle } from "../board";
import { expect, test } from "../fixtures";
import { setRole } from "../members";

test.use({ project: "comments" });

test("comments on a file frame", async ({ host, guest, serve }) => {
  await clear(host);
  const id = await add(host, "Files");
  await arrange(host, { [id]: { x: 0, y: 0, w: 900, h: 640 } });
  const of = (page: Page) => frame(page, id);
  const pick = async (page: Page, path: string) => {
    await of(page).getByPlaceholder("Search").fill(path.split("/").at(-1)!);
    await of(page).locator(`[role=treeitem][data-item-path="${path}"]`).click();
    await of(page).getByPlaceholder("Search").fill("");
  };
  const comments = () =>
    host.evaluate(
      (frameId) => [...(window as any).room.doc.getMap(`comments:${frameId}`).values()],
      id,
    ) as Promise<Array<Record<string, any>>>;
  const comment = async (body: string) => (await comments()).find((c) => c.body.startsWith(body));
  /** Hover a line, click the gutter's "+", write, save. */
  const write = async (page: Page, line: number, body: string) => {
    const at = of(page).locator(`[data-line="${line}"]`).first();
    await at.waitFor({ timeout: 10_000 });
    const box = (await at.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
    await of(page).locator("[data-utility-button]").click();
    await of(page).getByLabel("Comment", { exact: true }).fill(body);
    await page.keyboard.press("Control+Enter");
  };
  const card = (page: Page, text: string) => of(page).locator("[data-comment]", { hasText: text });
  const button = of(guest).locator("[data-comments-button]");

  await test.step("people write them from the gutter", async () => {
    await pick(host, "src/values.ts");
    await of(guest).locator('[data-line="10"]').first().waitFor({ timeout: 10_000 });
    await expect(
      of(host).locator("[data-comments-button]"),
      "no comments: no header button",
    ).toHaveCount(0);

    await write(host, 10, "Why is this **ten**?");
    await expect(card(guest, "Why is this").locator("strong"), "markdown, rendered").toHaveText(
      "ten",
      {
        timeout: 10_000,
      },
    );

    // The guest comments on a range: select 20–22 by the line numbers, then "+".
    await of(guest).locator('[data-column-number="20"]').first().click();
    await of(guest)
      .locator('[data-column-number="22"]')
      .first()
      .click({ modifiers: ["Shift"] });
    await write(guest, 22, "guest note");
    await expect(card(host, "guest note")).toBeVisible({ timeout: 10_000 });
    const note = (await comment("guest note"))!;
    expect([note.start, note.end], "the guest's range").toEqual([20, 22]);
    expect(note.quote.split("\n"), "it quotes its three lines").toHaveLength(3);
    expect([note.author.name, note.author.kind]).toEqual(["Ada", "person"]);
  });

  await test.step("their author changes them, and the host everyone's", async () => {
    const canEdit = async (page: Page, text: string) => {
      await card(page, text).hover();
      return card(page, text).getByTitle("Edit comment").isVisible();
    };
    expect(await canEdit(guest, "Why is this"), "the guest can't edit the host's").toBe(false);
    expect(await canEdit(guest, "guest note"), "the guest can edit their own").toBe(true);
    expect(await canEdit(host, "guest note"), "the host can edit the guest's").toBe(true);
    await card(guest, "guest note").getByTitle("Edit comment").click();
    await of(guest).getByLabel("Comment", { exact: true }).fill("guest note, edited");
    await of(guest).getByRole("button", { name: "Save" }).click();
    await expect(card(host, "guest note, edited"), "an edit reaches the host").toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("the header counts them, the tree badges the file", async () => {
    await expect(button).toHaveText("2");
    await of(host).getByPlaceholder("Search").fill("values.ts");
    await expect(of(host).locator('[role=treeitem][data-item-path="src/values.ts"]')).toContainText(
      "● 2",
    );
    await of(host).getByPlaceholder("Search").fill("");
  });

  await test.step("they stay with the frame; picking one goes back to it", async () => {
    await pick(host, "docs/readme.md");
    await of(guest).locator(".prose-canvas h1").waitFor({ timeout: 10_000 });
    await expect(button, "they stay when the frame shows another file").toHaveText("2");
    await button.click();
    await guest
      .locator("[data-comments-popover] [data-comment-link]", { hasText: "guest note" })
      .click();
    await of(host).locator('[data-line="22"]').first().waitFor({ timeout: 10_000 });
    const now = (await frames(host)).find((f) => f.id === id)!;
    expect([now.path, now.lines?.start, now.lines?.end], "its file at its lines").toEqual([
      "src/values.ts",
      20,
      22,
    ]);
  });

  await test.step("a markdown file's comment shows in its source", async () => {
    await pick(host, "docs/readme.md");
    await settle(500);
    await host.evaluate((frameId) => {
      (window as any).room.doc.getMap("frames").get(frameId).set("view", "source");
    }, id);
    await write(host, 5, "a list item");
    await pick(host, "src/values.ts");
    await of(host).locator("[data-comments-button]").click();
    await host
      .locator("[data-comments-popover] [data-comment-link]", { hasText: "a list item" })
      .click();
    await expect(card(guest, "a list item")).toBeVisible({ timeout: 10_000 });
    const now = (await frames(host)).find((f) => f.id === id)!;
    expect(now.path).toBe("docs/readme.md");
    expect(now.view ?? null, "picking it opens the source").toBeNull();
    expect(now.lines).toBeTruthy();
  });

  await test.step("the file changes on disk: comments follow their lines, or go outdated", async () => {
    await pick(host, "src/values.ts");
    await expect(card(host, "Why is this")).toBeVisible({ timeout: 10_000 });
    const file = join(serve.dir, "src/values.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `// one\n// two\n// three\n${original}`);
    await expect(of(guest).locator('[data-comment-line="13"]')).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(async () => (await comment("Why"))!.start, "lines moved down 3").toBe(13);
    writeFileSync(
      file,
      `// one\n// two\n// three\n${original.replace("value10 = 10", "value10 = 100")}`,
    );
    await expect(card(guest, "Why is this").locator("text=outdated")).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(async () => (await comment("Why"))!.outdated, "its line changed").toBe(true);
    await expect(
      of(guest).locator('[data-comment-line="0"] [data-comment]'),
      "an outdated comment shows above the first line",
    ).toHaveCount(1);
    writeFileSync(file, original);
    await expect(of(guest).locator('[data-comment-line="10"]')).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => !!(await comment("Why"))!.outdated, "the line is back")
      .toBe(false);
  });

  await test.step("the tree shows only files with comments, if asked", async () => {
    await of(host).getByTitle("Only files with comments").click();
    await expect
      .poll(async () =>
        (
          await of(host)
            .locator("[role=treeitem][data-item-type=file]")
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")))
        ).sort(),
      )
      .toEqual(["docs/readme.md", "src/values.ts"]);
    await of(host).getByTitle("Show every file").click();
    await of(host).getByTitle("Hide files").click();
    await expect(
      of(host).getByTitle("Show files"),
      "hiding the tree puts Show files in the header",
    ).toBeVisible();
    await of(host).getByTitle("Show files").click();
  });

  await test.step("the host deletes the guest's", async () => {
    await card(host, "guest note, edited").hover();
    await card(host, "guest note, edited").getByTitle("Delete comment").click();
    await expect(card(guest, "guest note")).toHaveCount(0);
  });

  await test.step("view guests read comments, but can't write them", async () => {
    await setRole(host, guest, "view");
    await settle(1500);
    const box = (await of(guest).locator('[data-line="30"]').first().boundingBox())!;
    await guest.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
    await settle(300);
    await expect(of(guest).locator("[data-utility-button]"), "no + for a view guest").toHaveCount(
      0,
    );
    await setRole(host, guest, "edit");
  });

  await test.step("comments are the frame's: a new frame has none, and they go with it", async () => {
    const row = of(host).locator('[role=treeitem][data-item-path="src/values.ts"]');
    await row.click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(async () => (await frames(host)).length).toBe(2);
    const other = (await frames(host)).find((f) => f.id !== id)!;
    await expect(frame(host, other.id).locator("[data-comments-button]")).toHaveCount(0);
    await of(host).getByTitle("Remove frame").click();
    await expect
      .poll(async () => (await comments()).length, "removing the frame removes them")
      .toBe(0);
  });
});
