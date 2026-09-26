// Screenshots for the docs site (`site/content/docs/screenshots/`). Drives a
// host and a guest, like `drive.ts`, against the demo project of
// `e2e/screenshots-demo.sh`, with a real Claude Code session. Raw PNGs land in
// $OUT (default /tmp/canvas-docs-shots); `site/scripts/shots.ts` converts the
// ones the docs use.
//
//   STEP=setup  an agent shows the login code on the board; a terminal, a preview
//   STEP=shots  everything else, on the board setup left
//   STEP=snap   a drag with its snap preview
import { chromium, type Locator, type Page } from "playwright";

const hostLink = process.argv[2]!;
const out = process.env.OUT ?? "/tmp/canvas-docs-shots";
const u = new URL(hostLink);
const f = new URLSearchParams(u.hash.slice(1));
const guestLink = `${u.origin}/?room=${u.searchParams.get("room")}#k=${f.get("k")}&pk=${f.get("pk")}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const open = async (url: string, name: string, color: string) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await context.addInitScript(
    // Guarded: it runs in the browser frame's iframe too, which has no storage.
    ([n, c]) => {
      try {
        localStorage.setItem("canvas.identity", JSON.stringify({ name: n, color: c }));
      } catch {}
    },
    [name, color],
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(url);
  return page;
};
const shot = (target: Page | Locator, name: string) =>
  target.screenshot({ path: `${out}/${name}.png` });

const host = await open(hostLink, "Karl", "#f97316");
await host.getByText("connected to canvas serve").waitFor({ timeout: 15000 });
const guest = await open(guestLink, "Ada", "#3b82f6");
await guest.getByText("host online").waitFor({ timeout: 30000 });

/** Add a frame from the toolbar and return its id. */
async function addFrame(page: Page, button: string) {
  const ids = () =>
    page
      .locator("[data-frame]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-frame")));
  const before = new Set(await ids());
  await page.locator("[data-hud]").getByRole("button", { name: button }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-frame]").length > n,
    before.size,
  );
  return (await ids()).find((id) => !before.has(id))!;
}

/** Put a frame somewhere in board coordinates, as its own change. */
const place = (page: Page, id: string, patch: Record<string, unknown>) =>
  page.evaluate(
    ([frameId, p]) => {
      const map = (window as any).room.doc.getMap("frames").get(frameId);
      (window as any).room.doc.transact(() => {
        for (const [k, v] of Object.entries(p as object)) map.set(k, v);
      });
    },
    [id, patch] as const,
  );

const frames = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, any>[] = [];
    (window as any).room.doc
      .getMap("frames")
      .forEach((map: any, id: string) => out.push({ id, ...map.toJSON() }));
    return out;
  });

const frameOf = (page: Page, id: string) => page.locator(`[data-frame="${id}"]`);
const fit = async (...pages: Page[]) => {
  for (const page of pages)
    await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  await wait(800);
};

/** The host answers every tool permission until the agent goes idle; the first one is shot. */
async function approveUntilIdle(agent: string, name: string) {
  let shots = 0;
  const deadline = Date.now() + 300_000;
  await wait(2000);
  while (Date.now() < deadline) {
    const allow = host.locator("[data-permission-kind=allow_once]").first();
    if (await allow.isVisible().catch(() => false)) {
      if (shots++ === 0) {
        await wait(500);
        await shot(frameOf(host, agent), `${name}-host-permission`);
        await shot(frameOf(guest, agent), `${name}-guest-permission`);
      }
      await allow.click();
    }
    if (await frameOf(host, agent).getByText("idle", { exact: true }).isVisible()) return;
    await wait(500);
  }
  throw new Error("agent never went idle");
}

const step = process.env.STEP ?? "setup";

if (step === "setup") {
  await host.evaluate(() => {
    const map = (window as any).room.doc.getMap("frames");
    for (const id of [...map.keys()]) map.delete(id);
  });

  // An agent: picker, then Claude Code.
  const agent = await addFrame(host, "Agent");
  await place(host, agent, { x: 0, y: 0, w: 480, h: 780 });
  await frameOf(host, agent).locator("[data-pick-agent]").first().waitFor();
  await host.getByTitle("Reset to 100%").click();
  await wait(500);
  await shot(frameOf(host, agent), "agent-picker");
  await frameOf(host, agent).locator("[data-pick-agent=claude]").click();
  await frameOf(host, agent)
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 60000 });

  // Host and guest write the prompt together; the guest sends, the host approves.
  await guest.locator(`[data-frame="${agent}"] .cm-content`).click();
  await guest.keyboard.type(
    "Show me the code that handles login on the board, at the relevant lines. ",
  );
  await host.locator(`[data-frame="${agent}"] .cm-content`).click();
  await host.keyboard.press("End");
  await host.keyboard.type("Then explain in two sentences how a password is checked.");
  await wait(800);
  await shot(frameOf(host, agent), "agent-draft");
  await guest.keyboard.press("Control+Enter");
  const approve = host.getByRole("button", { name: "Run on my machine" });
  await approve.waitFor({ timeout: 10000 });
  await wait(400);
  await shot(host, "approval");
  await approve.click();
  await approveUntilIdle(agent, "agent");
  await wait(1000);
  console.log(
    "board after the agent:\n  " +
      (await frames(host))
        .map((fr) => `${fr.id} ${fr.type} ${fr.title} @${fr.x},${fr.y} ${fr.w}x${fr.h}`)
        .join("\n  "),
  );
  await shot(frameOf(host, agent), "agent-thread");
}

if (step === "shots") {
  // Keep the agent's thread; rebuild the rest, starting with the file it opened.
  const agent = (await frames(host)).find((fr) => fr.type === "agent")!.id;
  await host.evaluate((keep) => {
    const map = (window as any).room.doc.getMap("frames");
    for (const id of [...map.keys()]) if (id !== keep) map.delete(id);
  }, agent);
  const login = await addFrame(host, "Files");
  await place(host, login, {
    x: 504,
    y: 0,
    w: 720,
    h: 780,
    path: "src/routes/login.ts",
    title: "login.ts",
    lines: { start: 5, end: 15 },
    origin: agent,
  });
  const all = await frames(host);
  const A = all.find((fr) => fr.id === agent)!;
  const L = all.find((fr) => fr.id === login)!;

  // Row 1: agent, login.ts, and the plan in markdown. Row 2: a terminal and a preview.
  const plan = await addFrame(host, "Files");
  await place(host, plan, {
    x: L.x + L.w + 24,
    y: 0,
    w: 620,
    h: A.h,
    path: "docs/plan.md",
    title: "plan.md",
  });
  const term = await addFrame(host, "Terminal");
  await place(host, term, { x: 0, y: A.h + 24, w: 900, h: 420 });
  const preview = await addFrame(host, "Browser");
  await place(host, preview, {
    x: 924,
    y: A.h + 24,
    w: 920,
    h: 420,
    url: "http://localhost:5199",
    title: "shop",
  });
  await wait(1500);

  // The terminal runs the demo's dev server, which the preview shows.
  await fit(host, guest);
  await frameOf(host, term).locator(".xterm").click();
  await wait(1000);
  await host.keyboard.type("git log --oneline && bun run dev\n");
  await frameOf(guest, term)
    .getByText("shop on")
    .first()
    .waitFor({ timeout: 15000 })
    .catch(async (error: unknown) => {
      await shot(host, "failed-host");
      await shot(guest, "failed-guest");
      throw error;
    });
  await frameOf(host, preview).getByTitle("Reload").click();
  await frameOf(guest, preview).getByTitle("Reload").click();
  await wait(1500);
  await shot(frameOf(host, term), "terminal");
  await shot(frameOf(host, preview), "browser");

  // The guest selects a step of the plan; the host sees it in the guest's colour.
  await frameOf(guest, plan).locator(".prose-canvas h1").waitFor({ timeout: 10000 });
  await frameOf(guest, plan).evaluate((section) => {
    const block = [...section.querySelectorAll("[data-sel-key]")].find((el) =>
      el.textContent?.includes("Refuse early"),
    )!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const range = document.createRange();
    range.setStart(nodes[0]!, 0);
    const last = nodes.at(-1)!;
    range.setEnd(last, last.length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await wait(1000);
  await shot(frameOf(host, plan), "files-preview");
  await guest.evaluate(() => document.getSelection()!.removeAllRanges());

  // Ada occupies login.ts; Karl follows Ada there.
  await frameOf(guest, login).click({ position: { x: 300, y: 300 } });
  await wait(1000);
  await shot(frameOf(host, login), "files-lines");

  // The whole board, from the host, with Ada's pointer on it.
  await fit(host, guest);
  const box = (await frameOf(guest, plan).boundingBox())!;
  await guest.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await host.mouse.move(700, 860);
  await wait(800);
  await shot(host, "board");
  await shot(guest, "board-guest");
  await shot(host.locator("header").first(), "topbar-host");
  await shot(guest.locator("header").first(), "topbar-guest");

  // Agent settings: the composer's chip opens them.
  await fit(host);
  await frameOf(host, agent).locator("[data-agent-settings]").click();
  await host.locator("[data-agent-settings-popover]").waitFor();
  await wait(500);
  await shot(host, "agent-settings");
  await host.keyboard.press("Escape");

  // A tool call that runs a command: the agent asks, only the host answers.
  await frameOf(host, agent).locator(".cm-content").click();
  await host.keyboard.type("Run `bun test` in the shell and tell me the result in one sentence.");
  await host.keyboard.press("Control+Enter");
  await approveUntilIdle(agent, "agent");
}

// Drag the preview a little out of its row: the snap preview shows where it lands.
if (step === "snap") {
  await fit(host);
  const preview = (await frames(host)).find((fr) => fr.type === "browser")!;
  const box = (await frameOf(host, preview.id).boundingBox())!;
  const k = box.width / preview.w;
  // By the header's icon: the title input keeps the pointer for itself.
  const from = { x: box.x + 14 * k, y: box.y + 18 * k };
  await host.mouse.move(from.x, from.y);
  await host.mouse.down();
  await host.mouse.move(from.x - 8, from.y + 45, { steps: 8 });
  await wait(400);
  await shot(host, "snap");
  await host.mouse.move(from.x, from.y, { steps: 8 });
  await host.mouse.up();
}

await browser.close();
