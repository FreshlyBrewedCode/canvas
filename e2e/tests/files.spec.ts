// Files frames (ADR 0002, finding 05): the shared set's tree, markdown
// rendered or as source, selections that show for everyone, the file on disk
// live; what the frame refuses to show, whoever asks.
import type { Page } from "@playwright/test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { add, arrange, clear, frame, frames, settle } from "../board";
import { expect, test } from "../fixtures";
import { setRole } from "../members";

/** Find a file with the tree's search, then click it (rows are virtualized). */
const pick = async (of: ReturnType<typeof frame>, path: string, modifier = false) => {
  await of.getByPlaceholder("Search").fill(path.split("/").at(-1)!);
  await of
    .locator(`[role=treeitem][data-item-path="${path}"]`)
    .click({ modifiers: modifier ? ["ControlOrMeta"] : [] });
  await of.getByPlaceholder("Search").fill("");
};
/** How many boxes a page draws for others' selections in a frame. */
const remoteSelections = (of: ReturnType<typeof frame>) =>
  of.locator("[data-sel-root] [aria-hidden] > div").count();

test.describe(() => {
  test.use({ project: "files" });

  test("a files frame shows the shared set", async ({ host, guest, serve }) => {
    // What the frame must refuse, made here: none of it belongs in the repo.
    writeFileSync(join(serve.dir, "big.ts"), `// big\n${"x".repeat(1100 * 1024)}\n`);
    writeFileSync(
      join(serve.dir, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 1, 2, 3]),
    );
    writeFileSync(join(serve.dir, ".env"), "SECRET=1\n");
    mkdirSync(join(serve.dir, ".canvas"), { recursive: true });
    writeFileSync(join(serve.dir, ".canvas/room.json"), "{}");
    symlinkSync("/etc", join(serve.dir, "etc-link"));

    await clear(host);
    const id = await add(host, "Files");
    await arrange(host, { [id]: { x: 0, y: 0, w: 900, h: 640 } });
    const of = (page: Page) => frame(page, id);

    await test.step("the tree, for everyone", async () => {
      for (const page of [host, guest])
        await expect(of(page).getByText("Pick a file from the tree.")).toBeVisible({
          timeout: 10_000,
        });
      const rows = await of(guest)
        .getByRole("treeitem")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")));
      expect(rows).toEqual(expect.arrayContaining(["docs/adr/", "src/", "big.ts", "logo.png"]));
      expect(rows, "no secrets in the tree").not.toContain(".env");
    });

    await test.step("markdown: rendered for everyone; a guest's selection shows", async () => {
      await pick(of(host), "docs/adr/0002-shared-files-read-only.md");
      await expect(of(guest).locator(".prose-canvas h1")).toHaveText(
        "0002 — Shared files, read-only",
        {
          timeout: 10_000,
        },
      );
      await of(guest).evaluate((section) => {
        const block = [...section.querySelectorAll("[data-sel-key]")].find((el) =>
          el.textContent?.includes("The markdown frame"),
        )!;
        const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const range = document.createRange();
        range.setStart(text, 4);
        range.setEnd(text, 18);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
      });
      await expect.poll(() => remoteSelections(of(host)), "the host sees it").toBeGreaterThan(0);
      await guest.evaluate(() => document.getSelection()!.removeAllRanges());
    });

    await test.step("as source, shared; a guest's lines show", async () => {
      await of(host).getByTitle("Show source").click();
      await of(guest).locator("diffs-container").waitFor({ timeout: 10_000 });
      await settle(800);
      const from = (await of(guest).locator('[data-column-number="3"]').first().boundingBox())!;
      const to = (await of(guest).locator('[data-column-number="6"]').first().boundingBox())!;
      await guest.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await guest.mouse.down();
      await guest.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
      await guest.mouse.up();
      await expect
        .poll(() =>
          guest.evaluate(() => {
            const s = (window as any).room.awareness.getLocalState().selection;
            return s && [s.start, s.end];
          }),
        )
        .toEqual([3, 6]);
      await expect
        .poll(
          () =>
            of(host)
              .locator("diffs-container")
              .evaluate((el) =>
                [...(el.shadowRoot?.querySelectorAll("style") ?? [])].some((s) =>
                  s.textContent?.includes('[data-line="3"]'),
                ),
              ),
          "the host draws the guest's lines",
        )
        .toBe(true);
    });

    await test.step("the guest browses; the file on disk is live", async () => {
      // Following Karl, the guest's tree is his (finding 18): opening a folder is their own.
      await of(guest)
        .locator('[data-item-path="src/"]:not([data-file-tree-sticky-row])')
        .first()
        .click();
      await expect
        .poll(() => of(guest).evaluate((el) => el.hasAttribute("data-following")))
        .toBe(false);
      await pick(of(guest), "src/server/files.ts");
      await expect(of(host).getByText("src/server/files.ts", { exact: true })).toBeVisible();
      writeFileSync(
        join(serve.dir, "src/server/files.ts"),
        "// rewritten on disk\nexport const live = true;\n",
      );
      await expect(of(guest).getByText("rewritten on disk")).toBeVisible({ timeout: 10_000 });
      await pick(of(guest), "src/generated.ts", true);
      await expect(
        host.locator("[data-frame-type=file]"),
        "⌘/Ctrl-click opens a second frame",
      ).toHaveCount(2, { timeout: 10_000 });
      const other = (await frames(host)).find((f) => f.id !== id)!;
      await frame(host, other.id).getByTitle("Remove frame").click();
    });

    await test.step("too large, binary", async () => {
      for (const [path, why] of [
        ["big.ts", "Too large"],
        ["logo.png", "Binary file"],
      ] as const) {
        await pick(of(host), path);
        await expect(of(guest).getByText(why)).toBeVisible({ timeout: 10_000 });
      }
    });

    await test.step("a path set through the board directly, as a hostile guest could", async () => {
      for (const path of [".env", ".canvas/room.json", "etc-link/hostname", "../../etc/passwd"]) {
        await guest.evaluate(
          ([frameId, p]) => (window as any).room.doc.getMap("frames").get(frameId).set("path", p),
          [id, path],
        );
        await expect(
          of(guest)
            .locator("p", { hasText: "not shared" })
            .or(of(guest).locator("p", { hasText: "outside the working dir" }))
            .first(),
          `${path} is refused`,
        ).toBeVisible({ timeout: 10_000 });
        await expect(of(guest).getByText("SECRET=1")).toHaveCount(0);
      }
    });

    await test.step("view guests see open files, but get no tree", async () => {
      await setRole(host, guest, "view");
      await pick(of(host), "docs/adr/0001-host-relayed-star-topology.md");
      await expect(of(guest).getByText("The host's browser is the only door").first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(of(guest).getByTitle(/files$/), "no tree toggle").toHaveCount(0);
      await expect(of(guest).getByRole("treeitem"), "no tree").toHaveCount(0);
      await setRole(host, guest, "edit");
    });
  });
});

test("a file frame with lines opens there, for everyone", async ({ host, guest }) => {
  await clear(host);
  const id = await add(host, "Files");
  await arrange(host, {
    [id]: {
      path: "src/big.ts",
      title: "big.ts",
      lines: { start: 400, end: 412 },
      x: 0,
      y: 0,
      h: 700,
    },
  });
  for (const page of [host, guest]) {
    await page.getByTitle("Reset to 100%").click();
    await frame(page, id).locator("diffs-container").waitFor({ timeout: 10_000 });
    await expect
      .poll(() =>
        frame(page, id).evaluate((section) => {
          const scroller = section.querySelector("diffs-container")!.closest(".overflow-auto")!;
          const line = section
            .querySelector("diffs-container")!
            .shadowRoot!.querySelector('[data-line="400"]');
          if (!line) return null;
          const top = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          return top >= 0 && top < scroller.getBoundingClientRect().height;
        }),
      )
      .toBe(true);
  }
});

test("resizing the tree on a zoomed board follows the pointer", async ({ host }) => {
  test.fail(true, "finding 05, Open: react-resizable-panels ignores the board's scale");
  await clear(host);
  const id = await add(host, "Files");
  await arrange(host, { [id]: { path: "README.md", x: 0, y: 0, w: 900, h: 640 } });
  await host.getByTitle("Zoom out").click();
  await settle(600);
  const panel = frame(host, id).locator("[data-slot=resizable-panel]").first();
  const handle = (await frame(host, id).locator("[data-slot=resizable-handle]").boundingBox())!;
  const before = (await panel.boundingBox())!.width;
  await host.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await host.mouse.down();
  await host.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, {
    steps: 6,
  });
  await host.mouse.up();
  expect((await panel.boundingBox())!.width - before, "a 60 px drag").toBeNear(60, 3);
});
