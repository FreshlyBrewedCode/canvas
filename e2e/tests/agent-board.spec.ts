// Agents act on the board (ADR 0003, findings 06, 07, 08, 11): through the
// board's MCP tools, which the host's browser runs. Claude Code, replayed from
// its recordings: the replay makes the recorded tool calls on this run's board.
import type { Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { ask, idle, newAgent, send } from "../agents";
import { add, arrange, at, clear, fit, frame, frames, settle } from "../board";
import { expect, test } from "../fixtures";
import { setRole } from "../members";

const gitStatus = (dir: string) =>
  spawnSync("git", ["status", "--porcelain"], { cwd: dir }).stdout.toString().trim();

test.describe("in the shop", () => {
  test.use({ project: "shop" });

  test("an agent shows files at their lines, closes them, opens a terminal", async ({
    host,
    guest,
    serve,
  }) => {
    await clear(host);
    const self = await newAgent(host, "claude");
    await arrange(host, { [self]: { x: 0, y: 0 } });
    // Another cluster far away, which the agent should leave alone.
    const readme = await add(host, "Files");
    await arrange(host, { [readme]: { x: 3000, y: 0, path: "README.md", title: "README.md" } });

    await test.step("the files about authentication, at their lines, beside it", async () => {
      await ask(
        host,
        self,
        "Show me the files relevant to authentication in this project on the board, at the " +
          "relevant lines. Keep your reply short.",
      );
      const all = await frames(host);
      const opened = all.filter((f) => f.origin === self);
      expect(opened.length, "it opened frames").toBeGreaterThan(0);
      expect(opened.every((f) => f.cluster === all.find((g) => g.id === self)!.cluster)).toBe(true);
      const R = all.find((f) => f.id === readme)!;
      expect(
        all.filter((f) => f.cluster === R.cluster),
        "README alone in its cluster",
      ).toHaveLength(1);
      await expect(frame(guest, opened[0]!.id), "the guest sees them").toBeVisible();
    });

    await test.step("lines of a file, a frame closed, a terminal below", async () => {
      await ask(
        host,
        self,
        "Open src/auth/password.ts at the lines of the function that verifies a password; close " +
          "the login.ts frame; and open a terminal in a new row below your frame. Short reply.",
      );
      const all = await frames(host);
      const password = all.find((f) => f.path === "src/auth/password.ts" && f.lines);
      expect(password?.lines?.start, "password.ts at verifyPassword").toBeGreaterThanOrEqual(10);
      expect(
        all.some((f) => f.path === "src/routes/login.ts"),
        "login.ts closed",
      ).toBe(false);
      const term = all.find((f) => f.type === "terminal");
      expect(term, "a terminal").toBeTruthy();
      expect(term!.y, "…below the agent").toBeGreaterThan((await at(host, self)).y);
    });

    await test.step("after a restart of canvas serve, the tools reach the reloaded session", async () => {
      await serve.restart();
      await expect(host.getByText("connected to canvas serve")).toBeVisible({ timeout: 30_000 });
      await ask(
        host,
        self,
        "Call view_board and tell me how many frames are in your cluster. One line.",
      );
      await expect(frame(host, self).getByText("view_board").last()).toBeVisible();
    });
    expect(gitStatus(serve.dir), "the project untouched").toBe("");
  });

  test("an agent shows what only belongs on the board as scratch files", async ({
    host,
    guest,
    serve,
  }) => {
    await clear(host);
    const self = await newAgent(host, "claude");
    await arrange(host, { [self]: { x: 0, y: 0 } });
    await ask(
      host,
      self,
      "On the board, show us a short markdown write-up of how login works in this project, and a " +
        "small HTML page that visualises the login flow as boxes and arrows. Keep your reply short.",
    );
    const all = await frames(host);
    const scratch = all.filter((f) => f.type === "file" && f.path?.startsWith("canvas:scratch/"));
    const md = scratch.find((f) => /\.md$/.test(f.path))!;
    const html = scratch.find((f) => /\.html?$/.test(f.path))!;
    expect(md, "a markdown scratch file").toBeTruthy();
    expect(html, "an HTML one").toBeTruthy();
    expect(gitStatus(serve.dir), "the project untouched").toBe("");
    expect(JSON.stringify(all).length, "the board holds paths, not content").toBeLessThan(4000);
    for (const p of [host, guest]) {
      await expect(frame(p, md.id).locator(".prose-canvas :is(h1, h2)").first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        frame(p, html.id).locator("iframe").contentFrame().locator("body"),
      ).not.toBeEmpty();
    }

    await test.step("another turn rewrites it in place; the frame follows", async () => {
      await ask(
        host,
        self,
        `Add a section "Open questions" with one question to the write-up at ${md.path}. Short reply.`,
      );
      await expect(frame(guest, md.id).locator(".prose-canvas")).toContainText("Open questions", {
        timeout: 10_000,
      });
      expect(
        (await frames(host)).filter((f) => f.path?.startsWith("canvas:scratch/")),
        "no new frame",
      ).toHaveLength(scratch.length);
      expect(gitStatus(serve.dir)).toBe("");
    });
  });

  test("an agent gathers a topic in one frame with a list", async ({ host, guest, serve }) => {
    await clear(host);
    const self = await newAgent(host, "claude");
    await arrange(host, { [self]: { x: 0, y: 0 } });
    await ask(
      host,
      self,
      "Show us everything about login in this project in one file frame we can click through: a " +
        "short write-up first, then the relevant source files grouped in folders by layer, at the " +
        "relevant lines, and a small HTML visualisation of the flow last. Keep your reply short.",
    );
    const listed = (await frames(host)).filter((f) => f.type === "file" && f.files?.length);
    expect(listed, "one file frame with a list").toHaveLength(1);
    const target = listed[0]!;
    type Item = { display: string; path: string; lines?: { start: number; end: number } };
    const list = target.files as Item[];
    expect(
      (await frames(host)).filter((f) => f.type === "file" && f.origin === self),
      "no frame per file",
    ).toHaveLength(1);
    expect(
      list.some((e) => e.path.startsWith("canvas:scratch/")),
      "scratch files",
    ).toBe(true);
    expect(
      list.some((e) => !e.path.startsWith("canvas:scratch/")),
      "and project files",
    ).toBe(true);
    expect(gitStatus(serve.dir), "the project untouched").toBe("");

    const of = (p: Page) => frame(p, target.id);
    const rows = (p: Page) =>
      of(p)
        .locator("[role=treeitem][data-item-type=file]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")));
    const selected = (p: Page) =>
      of(p).locator("[role=treeitem][aria-selected=true]").getAttribute("data-item-path");

    await test.step("the tree is the list, in its order, folders open", async () => {
      for (const p of [host, guest]) {
        await of(p).locator("[role=treeitem]").first().waitFor({ timeout: 10_000 });
        expect(await rows(p)).toEqual(list.map((e) => e.display));
      }
      // A folder sorts where its first entry is: Zeta's two files stay together.
      await arrange(host, {
        [target.id]: {
          files: [
            { display: "Zeta/b.ts", path: "src/auth/session.ts" },
            { display: "Alpha/a.ts", path: "src/auth/password.ts", lines: { start: 2, end: 4 } },
            { display: "Zeta/a.ts", path: "src/routes/login.ts" },
            { display: "top.md", path: "README.md" },
          ],
        },
      });
      await expect
        .poll(() => rows(guest))
        .toEqual(["Zeta/b.ts", "Zeta/a.ts", "Alpha/a.ts", "top.md"]);
      await arrange(host, { [target.id]: { files: list } });
    });

    const pick = list.find((e) => e.lines && !e.path.startsWith("canvas:scratch/")) ?? list[1]!;
    await test.step("the guest clicks through: the frame follows for everyone", async () => {
      if (pick.lines)
        await expect(
          of(guest).locator(`[role=treeitem][data-item-path="${pick.display}"]`),
          "the lines show as a badge",
        ).toContainText(`L${pick.lines.start}`);
      await of(guest).locator(`[role=treeitem][data-item-path="${pick.display}"]`).click();
      await expect.poll(async () => (await at(host, target.id)).path).toBe(pick.path);
      const now = await at(host, target.id);
      expect(now.lines ?? null).toEqual(pick.lines ?? null);
      expect(now.title, "the list keeps its title").toBe(target.title);
      await expect.poll(() => selected(host), "the host's list selects it too").toBe(pick.display);
    });

    await test.step("all files, for one viewer", async () => {
      await of(guest).getByTitle("Show all files").click();
      await expect.poll(() => selected(guest), "selected where it lives").toBe(pick.path);
      expect(await rows(host), "the host still sees the list").toHaveLength(list.length);
      await of(guest).getByTitle("Show the list").click();
    });

    await test.step("a view guest sees the list, can't click through, gets no full tree", async () => {
      await setRole(host, guest, "view");
      await settle(1500);
      const other = list.find((e) => e.display !== pick.display)!;
      expect(await rows(guest)).toHaveLength(list.length);
      await of(guest).locator(`[role=treeitem][data-item-path="${other.display}"]`).click();
      await settle(800);
      expect((await at(host, target.id)).path, "a click doesn't change the frame").toBe(pick.path);
      expect(await selected(guest), "the selection snaps back").toBe(pick.display);
      await expect(of(guest).getByTitle("Show all files")).toHaveCount(0);
      await setRole(host, guest, "edit");
    });
  });
});

test.describe("on a long file", () => {
  // In real time, up to 300 ms between messages: the agent stays in the frame long enough to see.
  test.use({ serveEnv: { CANVAS_REPLAY_GAP_MS: "300" } });

  test("an agent occupies the frame it opens until its turn ends", async ({ host, guest }) => {
    await clear(host);
    const self = await newAgent(host, "claude");
    await arrange(host, { [self]: { x: 0, y: 0, h: 560 } });
    const turn = await send(
      host,
      self,
      "Open src/big.ts at lines 400-410 on the board, then explain those lines in about 300 words.",
    );
    const occupied = guest.locator("[data-frame-type=file][data-occupant]");
    const title = await frame(host, self).getByLabel("Frame title").inputValue();
    // Who is in a file frame, read at once: the agent leaves when its turn ends.
    await expect
      .poll(
        () => occupied.evaluateAll((els) => els.map((el) => el.getAttribute("data-occupant"))),
        {
          message: "the guest sees the agent in the frame it opened",
          timeout: 60_000,
        },
      )
      .toEqual([title]);
    await idle(host, self, { turn });
    await expect(occupied, "the agent left the frame when its turn ended").toHaveCount(0);

    await test.step("its thread scrolls with whoever occupies the agent frame", async () => {
      for (const page of [host, guest]) await fit(page);
      const thread = (page: Page) => frame(page, self).locator("[data-frame-body]").first();
      const box = (await thread(host).boundingBox())!;
      await host.mouse.click(box.x + box.width / 2, box.y + 20);
      await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 4; i++) await host.mouse.wheel(0, -120);
      const top = (page: Page) => thread(page).evaluate((el) => Math.round(el.scrollTop));
      const end = await thread(host).evaluate((el) => el.scrollHeight - el.clientHeight);
      await expect.poll(() => top(host)).toBeLessThan(end - 40);
      await expect
        .poll(async () => Math.abs((await top(host)) - (await top(guest))))
        .toBeLessThanOrEqual(2);
    });
  });
});

test.describe("on comments", () => {
  test.use({ project: "comments" });

  test("an agent reads comments, writes its own, and points a frame at one", async ({
    host,
    guest,
  }) => {
    await clear(host);
    const self = await newAgent(host, "claude");
    await arrange(host, { [self]: { x: 0, y: 0 } });
    const id = await add(host, "Files");
    await arrange(host, {
      [id]: { x: 484, y: 0, w: 820, h: 620, path: "src/values.ts", title: "values.ts" },
    });
    const comments = () =>
      host.evaluate(
        (frameId) => [...(window as any).room.doc.getMap(`comments:${frameId}`).values()],
        id,
      ) as Promise<Array<Record<string, any>>>;
    // Karl's comments, as the gutter writes them.
    await host.evaluate((frameId) => {
      const map = (window as any).room.doc.getMap(`comments:${frameId}`);
      const author = { kind: "person", id: "karl", name: "Karl", color: "#f97316" };
      map.set("k1", {
        id: "k1",
        path: "src/values.ts",
        start: 20,
        end: 22,
        author,
        at: Date.now(),
        quote: [20, 21, 22].map((n) => `export const value${n} = ${n}; // line ${n}`).join("\n"),
        body: "What is the sum of the three values on these lines?",
      });
      map.set("k2", {
        id: "k2",
        path: "src/deep/greet.ts",
        start: 2,
        end: 2,
        author,
        at: Date.now(),
        quote: "  return `hi ${name}`;",
        body: "Which greeting word does this use?",
      });
    }, id);

    await ask(
      host,
      self,
      "Karl left comments in the files frame next to you. Read them and answer each in your reply. " +
        "Then leave a comment of your own in that frame on line 40 of src/values.ts, saying which " +
        "constant it exports. Keep it short.",
    );
    const reply = (await frame(host, self).locator(".prose-canvas").allInnerTexts())
      .join("\n")
      .toLowerCase();
    expect(reply, "it read the range comment (20 + 21 + 22)").toContain("63");
    expect(reply, "and the one on the other file").toContain("hi");
    // Its own on line 40; it may answer Karl's in comments of its own too.
    const mine = (await comments()).find((c) => c.author.kind === "agent" && c.start === 40)!;
    expect(mine, "its comment, on line 40").toBeTruthy();
    expect(mine.author.frame, "by its frame").toBe(self);
    expect(mine.quote).toContain("value40");
    await expect(frame(guest, id).locator(`[data-comment="${mine.id}"]`)).toBeVisible({
      timeout: 10_000,
    });

    await ask(
      host,
      self,
      "Change your comment to say just 'checked'. Then delete Karl's comment about greet.ts. Short reply.",
    );
    const after = await comments();
    expect(
      after.filter((c) => c.author.kind === "agent").map((c) => c.body),
      "it edited its comment",
    ).toContain("checked");
    expect(
      after.some((c) => c.id === "k2"),
      "it can't delete Karl's",
    ).toBe(true);

    await ask(
      host,
      self,
      "Show Karl's comment about src/values.ts on the board: point that frame at it. Short reply.",
    );
    const now = await at(host, id);
    expect([now.path, now.lines?.start, now.lines?.end]).toEqual(["src/values.ts", 20, 22]);
  });
});

test("an agent sees a drawing, draws a flowchart into it, and takes things out again", async ({
  host,
  guest,
}) => {
  const elements = (p: Page, id: string) =>
    p.evaluate(
      (frameId) =>
        [...(window as any).room.doc.getMap(`drawing:${frameId}`).values()].filter(
          (e: any) => !e.isDeleted,
        ),
      id,
    ) as Promise<Array<Record<string, any>>>;
  await clear(host);
  const self = await newAgent(host, "claude");
  await arrange(host, { [self]: { x: 0, y: 0 } });
  const id = await add(host, "Drawing");
  await arrange(host, { [id]: { x: 484, y: 0, h: 620 } });
  await fit(host);
  await fit(guest);

  await test.step("Karl sketches a house with the pen", async () => {
    await frame(host, id).locator("[data-drawing-edit]").click();
    await frame(host, id).locator("[data-drawing-editor] .excalidraw").waitFor({ timeout: 20_000 });
    await settle(800);
    const box = (await frame(host, id).locator("[data-drawing-editor]").boundingBox())!;
    await host.mouse.click(box.x + box.width - 80, box.y + box.height - 140);
    await host.keyboard.press("p");
    const stroke = async (points: Array<[number, number]>) => {
      await host.mouse.move(box.x + points[0]![0], box.y + points[0]![1]);
      await host.mouse.down();
      for (const [x, y] of points.slice(1))
        await host.mouse.move(box.x + x, box.y + y, { steps: 8 });
      await host.mouse.up();
    };
    const [l, t, w] = [260, 200, 160];
    await stroke([
      [l, t],
      [l, t + w],
      [l + w, t + w],
      [l + w, t],
      [l, t],
    ]); // walls
    await stroke([
      [l - 20, t],
      [l + w / 2, t - 90],
      [l + w + 20, t],
    ]); // roof
    await stroke([
      [l + 60, t + w],
      [l + 60, t + 90],
      [l + 100, t + 90],
      [l + 100, t + w],
    ]); // door
    await host.keyboard.press("Escape");
    await host.mouse.click(5, 400);
    await expect.poll(async () => (await elements(host, id)).length).toBe(3);
  });

  await test.step("it sees the sketch, in view_frame's image", async () => {
    await ask(
      host,
      self,
      "Look at the drawing frame next to you. What did Karl sketch in it? Answer in one short sentence.",
    );
    await expect(frame(host, self).locator(".prose-canvas").last()).toContainText(
      /house|home|hut|cabin|building/i,
    );
  });

  await test.step("it draws a mermaid flowchart below it", async () => {
    await ask(
      host,
      self,
      "Below Karl's sketch in that drawing, add a mermaid flowchart of how a guest's prompt reaches " +
        "an agent: guest browser -> host browser -> canvas serve -> agent. Short reply.",
    );
    const all = await elements(host, id);
    const labels = all
      .filter((e) => e.type === "text")
      .map((e) => String(e.text).toLowerCase().replace(/\s+/g, " "));
    expect(
      labels.some((text) => text.includes("canvas serve")),
      labels.join(" | "),
    ).toBe(true);
    expect(all.some((e) => e.type === "arrow")).toBe(true);
    expect(
      all.filter((e) => e.type === "freedraw"),
      "Karl's sketch untouched",
    ).toHaveLength(3);
    await expect
      .poll(() => guest.evaluate((n) => (window as any).room.doc.getMap(`drawing:${n}`).size, id))
      .toBeGreaterThanOrEqual(all.length);
  });

  let you: Record<string, any> | undefined;
  await test.step("a shape bound to what is there", async () => {
    await ask(
      host,
      self,
      "Next to the 'agent' box of your flowchart, add a red ellipse labelled 'you', with an arrow " +
        "from the agent box to it. Short reply.",
    );
    const all = await elements(host, id);
    you = all.find(
      (e) => e.type === "ellipse" && all.some((t) => t.containerId === e.id && /you/i.test(t.text)),
    );
    expect(you, "the ellipse").toBeTruthy();
    const arrow = all.find((e) => e.type === "arrow" && e.endBinding?.elementId === you!.id);
    const from = arrow && all.find((e) => e.id === arrow.startBinding?.elementId);
    expect(
      !!from && all.some((t) => t.containerId === from.id && /agent/i.test(t.text)),
      "the arrow is bound from the agent box to it",
    ).toBe(true);
    expect(
      (from?.boundElements ?? []).some((b: any) => b.id === arrow!.id),
      "the agent box knows its new arrow",
    ).toBe(true);
  });

  await test.step("and takes it out again", async () => {
    await ask(host, self, "Remove the ellipse and its arrow again. Short reply.");
    const all = await elements(host, id);
    expect(
      all.some((e) => e.id === you!.id),
      "the ellipse is gone",
    ).toBe(false);
    expect(
      all.filter((e) => e.type === "freedraw"),
      "Karl's sketch is still there",
    ).toHaveLength(3);
  });
});
