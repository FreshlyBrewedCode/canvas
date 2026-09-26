// Exploratory multi-user drive: a host and a guest in separate browser
// contexts against the running dev server + `canvas serve`. Screenshots land
// in $OUT (default /tmp/canvas-shots).
import { chromium, type Page } from "playwright";

const hostLink = process.argv[2]!;
const out = process.env.OUT ?? "/tmp/canvas-shots";
const u = new URL(hostLink);
const f = new URLSearchParams(u.hash.slice(1));
const guestLink = `${u.origin}/?room=${u.searchParams.get("room")}#k=${f.get("k")}&pk=${f.get("pk")}`;

const browser = await chromium.launch();
const open = async (url: string, name: string, color: string) => {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: "dark",
  });
  await context.addInitScript(
    ([n, c]) => localStorage.setItem("canvas.identity", JSON.stringify({ name: n, color: c })),
    [name, color],
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !m.text().includes("WebSocket connection to 'wss://") &&
      console.log(`[${name}]`, m.text()),
  );
  await page.goto(url);
  return page;
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}.png` });

const host = await open(hostLink, "Karl", "#f97316");
await host.getByText("connected to canvas serve").waitFor({ timeout: 15000 });
const guest = await open(guestLink, "Ada", "#3b82f6");
await guest.getByText("host online").waitFor({ timeout: 30000 });
console.log("guest sees host");

/** The host answers every tool permission the agent asks for until it goes idle. */
async function approveUntilIdle(host: Page, guest: Page) {
  let shots = 0;
  const deadline = Date.now() + 240_000;
  // The status flips to running a moment after sending.
  await new Promise((r) => setTimeout(r, 2000));
  while (Date.now() < deadline) {
    const allow = host.locator("[data-permission-kind=allow_once]").first();
    if (await allow.isVisible().catch(() => false)) {
      if (shots++ === 0) {
        await shot(host, "02b-host-permission");
        await shot(guest, "02b-guest-permission");
      }
      await allow.click();
    }
    if (
      await host
        .locator("[data-frame-type=agent]")
        .last()
        .getByText("idle", { exact: true })
        .isVisible()
    )
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("agent never went idle");
}

/**
 * Add a frame from the toolbar and return it. Frames render in a stable
 * order, not creation order, so the new one is found by its id.
 */
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
  const id = (await ids()).find((frameId) => !before.has(frameId));
  return page.locator(`[data-frame="${id}"]`);
}

/** Add an agent frame from the toolbar and pick which agent runs it. */
async function newAgent(page: Page, kind: string) {
  const frame = await addFrame(page, "Agent");
  await frame.locator(`[data-pick-agent=${kind}]`).click();
  return frame;
}

const step = process.env.STEP ?? "basic";
if (step === "approve") await approveUntilIdle(host, guest);
if (step === "basic") {
  await newAgent(host, "opencode");
  await guest.locator("[data-frame-type=agent]").last().waitFor({ timeout: 10000 });
  console.log("guest sees agent frame");
  // Both write into the same prompt draft.
  await guest.locator("[data-frame-type=agent] .cm-content").last().click();
  await guest.keyboard.type("Create docs/plan.md with a 3-step plan for a todo app. ");
  await host.locator("[data-frame-type=agent] .cm-content").last().click();
  await host.keyboard.press("End");
  await host.keyboard.type("Keep it short.");
  await host.mouse.move(700, 300);
  await guest.mouse.move(500, 500);
  await new Promise((r) => setTimeout(r, 800));
  console.log(
    "draft:",
    await guest.locator("[data-frame-type=agent] .cm-content").last().innerText(),
  );
  await shot(host, "01-host-draft");
  await shot(guest, "01-guest-draft");
  // Guest sends → host must approve (default access: edit).
  await guest.keyboard.press("Control+Enter");
  await host.getByRole("button", { name: "Run on my machine" }).waitFor({ timeout: 10000 });
  await shot(host, "02-host-approval");
  await host.getByRole("button", { name: "Run on my machine" }).click();
  await guest
    .locator("[data-frame-type=agent] [data-sel-key$=':prompt']")
    .first()
    .waitFor({ timeout: 10000 });
  await approveUntilIdle(host, guest);
  await new Promise((r) => setTimeout(r, 1000));
  await shot(host, "03-host-done");
  await shot(guest, "03-guest-done");
}

if (step === "claude") {
  const frame = await newAgent(host, "claude");
  const id = await frame.getAttribute("data-frame");
  await host.evaluate(
    ([frameId]) => {
      const map = (window as any).room.doc.getMap("frames").get(frameId);
      map.set("x", 1520);
      map.set("y", 60);
      map.set("h", 700);
    },
    [id],
  );
  await frame.locator(".cm-content").click();
  await host.keyboard.type(
    "Append a 4th step about deployment to docs/plan.md. Reply in one sentence.",
  );
  await host.keyboard.press("Control+Enter");
  await approveUntilIdle(host, guest);
  await new Promise((r) => setTimeout(r, 1000));
  await guest
    .locator(`[data-frame="${id}"]`)
    .screenshot({ path: `${out}/07-guest-claude-frame.png` });
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 500));
  await shot(host, "07-host-board");
}

if (step === "selection") {
  // Put the file frame beside the agent, then the guest selects reply text.
  for (const page of [host]) {
    await page.evaluate(() => {
      const room = (window as any).room;
      room.doc.getMap("frames").forEach((map: any) => {
        if (map.get("type") === "file") map.set("x", 1000);
        if (map.get("type") === "agent") {
          map.set("x", 460);
          map.set("y", 60);
          map.set("h", 700);
        }
      });
    });
  }
  await new Promise((r) => setTimeout(r, 800));
  const selected = await guest.evaluate(() => {
    const el = [...document.querySelectorAll("[data-sel-key]")].find((e) =>
      e.textContent?.includes("Created"),
    )!;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode() as Text;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, Math.min(first.length, 7));
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return range.toString() + " @ " + el.getAttribute("data-sel-key");
  });
  console.log("guest selected:", selected);
  await guest.mouse.move(200, 300);
  await new Promise((r) => setTimeout(r, 1000));
  const boxes = await host.evaluate(
    () => document.querySelectorAll("[data-sel-root] [aria-hidden] > div").length,
  );
  console.log("host renders selection boxes:", boxes);
  await host
    .locator("[data-frame-type=agent]")
    .screenshot({ path: `${out}/06-host-sees-guest-selection.png` });
}

if (step === "extras") {
  // A file frame on the file the agent wrote.
  const md = await addFrame(host, "Files");
  await md.waitFor();
  const id = await md.getAttribute("data-frame");
  await host.evaluate(
    ([frameId]) => {
      const room = (window as any).room;
      const map = room.doc.getMap("frames").get(frameId);
      room.doc.transact(() => {
        map.set("path", "docs/plan.md");
        map.set("title", "plan");
        map.set("x", 560);
        map.set("y", 120);
      });
    },
    [id],
  );
  await guest
    .locator(`[data-frame="${id}"]`)
    .getByText("Todo App Plan")
    .waitFor({ timeout: 10000 });
  console.log("guest sees plan.md rendered");

  // The guest selects text in the agent thread; the host sees it.
  await guest.evaluate(() => {
    const el = document.querySelector("[data-sel-key$=':prompt']")!;
    const range = document.createRange();
    range.setStart(el.firstChild!, 7);
    range.setEnd(el.firstChild!, 30);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await new Promise((r) => setTimeout(r, 800));
  await guest.mouse.move(300, 400);
  await host.mouse.move(900, 500);
  await new Promise((r) => setTimeout(r, 500));
  await shot(host, "04-host-remote-selection");

  // A terminal, host types, guest sees output; guest typing is refused in `edit` access.
  const term = await addFrame(host, "Terminal");
  await term.waitFor();
  const termId = await term.getAttribute("data-frame");
  await host.evaluate(
    ([frameId]) => {
      const map = (window as any).room.doc.getMap("frames").get(frameId);
      map.set("x", 40);
      map.set("y", 760);
    },
    [termId],
  );
  await new Promise((r) => setTimeout(r, 1500));
  await term.locator(".xterm").click();
  await host.keyboard.type("ls docs && cat docs/plan.md | head -3\n");
  await guest
    .locator(`[data-frame="${termId}"]`)
    .getByText("Todo App Plan")
    .first()
    .waitFor({ timeout: 10000 });
  console.log("guest sees terminal output");
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await guest.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 500));
  await shot(host, "05-host-board");
  await shot(guest, "05-guest-board");
}
if (step === "config") {
  // Host: an agent frame starts with the agent picker.
  const frame = await addFrame(host, "Agent");
  await frame.locator("[data-pick-agent]").first().waitFor();
  await shot(host, "10-host-agent-picker");
  await frame.locator("[data-pick-agent=claude]").click();
  const id = await frame.getAttribute("data-frame");
  const chip = frame.locator("[data-agent-settings]");
  const guestChip = guest.locator(`[data-frame="${id}"] [data-agent-settings]`);
  // The agent comes up on its own and reports its model.
  const t0 = Date.now();
  await chip.getByText("starting agent…").waitFor({ state: "detached", timeout: 30000 });
  console.log(`settings listed after ${Date.now() - t0} ms:`, await chip.innerText());

  // Host picks a model, then an effort the new model offers.
  await chip.click();
  const popover = host.locator("[data-agent-settings-popover]");
  await popover.waitFor();
  await shot(host, "11-host-settings-open");
  await popover.locator("[data-choice=sonnet]").click();
  await popover.locator("[data-setting=effort]").waitFor({ timeout: 10000 });
  await popover
    .locator("[data-setting=effort]")
    .getByRole("button", { name: "High", exact: true })
    .click();
  await chip.getByText("High").waitFor({ timeout: 10000 });
  await shot(host, "12-host-settings-changed");
  await host.keyboard.press("Escape");
  await guestChip
    .getByText("Sonnet 5 · High")
    .waitFor({ timeout: 10000 })
    .catch(async (error: unknown) => {
      console.log("guest chip:", await guestChip.innerText().catch(() => "(none)"));
      await shot(guest, "12-guest-failed");
      throw error;
    });
  console.log("guest sees:", await guestChip.innerText());

  // Guest (edit access) asks for another effort; the host approves it.
  await guestChip.click();
  await guest
    .locator("[data-agent-settings-popover] [data-setting=effort]")
    .getByRole("button", { name: "Low", exact: true })
    .click();
  const approve = host.getByRole("button", { name: "Run on my machine" });
  await approve.waitFor({ timeout: 10000 });
  console.log("approval:", await host.locator("[data-status=ready] p").first().innerText());
  await shot(host, "13-host-config-approval");
  await approve.click();
  await chip.getByText("Sonnet 5 · Low").waitFor({ timeout: 10000 });
  await guest.keyboard.press("Escape");
  console.log("after approval host sees:", await chip.innerText());

  // The next prompt runs on the chosen model.
  await frame.locator(".cm-content").click();
  await host.keyboard.type("Which Claude model are you? Answer in five words or fewer.");
  await host.keyboard.press("Control+Enter");
  await approveUntilIdle(host, guest);
  console.log("reply:", await frame.locator(".prose-canvas").last().innerText({ timeout: 10000 }));
  await shot(guest, "14-guest-after-turn");

  // opencode: hundreds of models, so the model list is searchable.
  const oc = await newAgent(host, "opencode");
  const ocChip = oc.locator("[data-agent-settings]");
  await ocChip.getByText("starting agent…").waitFor({ state: "detached", timeout: 30000 });
  await ocChip.click();
  await host.locator("[data-agent-settings-popover] input[aria-label=Search]").fill("glm 5.3");
  await shot(host, "15-host-opencode-search");
  await host.locator("[data-agent-settings-popover] [data-choice='opencode-go/glm-5.3']").click();
  await host.locator("[data-agent-settings-popover] [data-setting=effort]").waitFor();
  await shot(host, "16-host-opencode-effort");
  await host.keyboard.press("Escape");
  console.log("opencode chip:", await ocChip.innerText());
}

// Run against a scratch repo made by the files validation (finding 05):
// docs/adr/*.md, src/server/*.ts, big.ts (> 1 MiB), logo.png, .env, …
if (step === "files") {
  const dir = process.env.DIR ?? "/tmp/canvas-demo";
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let frameId = "";
  const frameOf = (page: Page) => page.locator(`[data-frame="${frameId}"]`);
  /** Find a file with the tree's search, then click it (rows are virtualized). */
  const pick = async (page: Page, path: string, modifier = false) => {
    const frame = frameOf(page);
    const name = path.split("/").at(-1)!;
    await frame.getByPlaceholder("Search").fill(name);
    await frame
      .locator(`[role=treeitem][data-item-path="${path}"]`)
      .click({ modifiers: modifier ? ["ControlOrMeta"] : [] });
    await frame.getByPlaceholder("Search").fill("");
  };

  frameId = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  await frameOf(host).getByText("Pick a file from the tree.").waitFor({ timeout: 10000 });
  await frameOf(guest).getByText("Pick a file from the tree.").waitFor({ timeout: 10000 });
  await wait(800);
  await shot(host, "20-host-tree");
  const tree = await frameOf(guest)
    .getByRole("treeitem")
    .evaluateAll((rows) => rows.map((row) => row.textContent?.replace(/…/g, "")));
  console.log("guest tree (top level):", tree.join(", "));

  // Markdown: rendered by default, for everyone.
  await pick(host, "docs/adr/0002-shared-files-read-only.md");
  await frameOf(guest).locator(".prose-canvas h1").waitFor({ timeout: 10000 });
  console.log("guest preview h1:", await frameOf(guest).locator(".prose-canvas h1").innerText());
  await shot(guest, "21-guest-markdown-preview");

  // The guest selects text in the preview; the host sees it in the guest's colour.
  const selected = await frameOf(guest).evaluate((section) => {
    const block = [...section.querySelectorAll("[data-sel-key]")].find((el) =>
      el.textContent?.includes("The markdown frame"),
    )!;
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 18);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return `${range.toString()} @ ${block.getAttribute("data-sel-key")}`;
  });
  console.log("guest selected in preview:", selected);
  await wait(1000);
  console.log(
    "host preview selection boxes:",
    await frameOf(host).locator("[data-sel-root] [aria-hidden] > div").count(),
  );
  await frameOf(host).screenshot({ path: `${out}/21b-host-sees-preview-selection.png` });
  await guest.evaluate(() => document.getSelection()!.removeAllRanges());

  // Toggle to source: shared.
  await frameOf(host).getByTitle("Show source").click();
  await frameOf(guest).locator("diffs-container").waitFor({ timeout: 10000 });
  await wait(800);
  await shot(guest, "22-guest-markdown-source");

  // The guest drags over line numbers 3–6; the host sees those lines.
  const from = (await frameOf(guest).locator('[data-column-number="3"]').first().boundingBox())!;
  const to = (await frameOf(guest).locator('[data-column-number="6"]').first().boundingBox())!;
  await guest.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await guest.mouse.down();
  await guest.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await guest.mouse.up();
  await wait(1000);
  console.log(
    "guest presence:",
    await guest.evaluate(() =>
      JSON.stringify((window as any).room.awareness.getLocalState().selection),
    ),
  );
  console.log(
    "host draws guest's lines:",
    await frameOf(host)
      .locator("diffs-container")
      .evaluate((el) =>
        [...(el.shadowRoot?.querySelectorAll("style") ?? [])].some((s) =>
          s.textContent?.includes('[data-line="3"]'),
        ),
      ),
  );
  await frameOf(host).screenshot({ path: `${out}/22b-host-sees-guest-lines.png` });

  // The guest browses: a TypeScript file, highlighted, for the host too.
  await pick(guest, "src/server/files.ts");
  await frameOf(host).getByText("src/server/files.ts", { exact: true }).waitFor();
  await wait(1200);
  await shot(host, "23-host-typescript");

  // Live: an agent (here: us) rewrites the file on disk.
  await Bun.write(
    `${dir}/src/server/files.ts`,
    "// rewritten on disk\nexport const live = true;\n",
  );
  await frameOf(guest).getByText("rewritten on disk").waitFor({ timeout: 10000 });
  console.log("guest saw the disk change");

  // ⌘/Ctrl-click opens a second frame.
  await pick(guest, "src/generated.ts", true);
  await host.locator("[data-frame-type=file]").nth(1).waitFor({ timeout: 10000 });
  console.log("file frames on host:", await host.locator("[data-frame-type=file]").count());
  await wait(1500);
  await shot(host, "24-host-two-frames");

  // What the frame refuses to show.
  for (const [path, expect] of [
    ["big.ts", "Too large"],
    ["logo.png", "Binary file"],
  ] as const) {
    await pick(host, path);
    await frameOf(guest)
      .getByText(expect)
      .waitFor({ timeout: 10000 })
      .catch(async (error: unknown) => {
        await shot(host, "fail-host");
        await shot(guest, "fail-guest");
        throw error;
      });
    console.log(`${path}: ${expect}`);
  }
  // A path set through the board directly, as a hostile guest could.
  for (const path of [".env", ".canvas/room.json", "etc-link/hostname", "../../etc/passwd"]) {
    await guest.evaluate(
      ([p]) => {
        const frames = (window as any).room.doc.getMap("frames");
        const id = [...frames.keys()].find((k: string) => frames.get(k).get("type") === "file");
        frames.get(id).set("path", p);
      },
      [path],
    );
    const notice = frameOf(guest)
      .locator("p", { hasText: "not shared" })
      .or(frameOf(guest).locator("p", { hasText: "outside the working dir" }));
    await notice.first().waitFor({ timeout: 10000 });
    console.log(`${path} →`, await notice.first().innerText());
  }
  await shot(guest, "25-guest-denied");

  // Resizing the tree on a zoomed board: the handle follows the pointer.
  await host.getByTitle("Zoom out").click();
  await wait(300);
  const panel = frameOf(host).locator("[data-slot=resizable-panel]").first();
  const handle = frameOf(host).locator("[data-slot=resizable-handle]");
  const before = (await panel.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await host.mouse.down();
  await host.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
  await host.mouse.up();
  const after = (await panel.boundingBox())!.width;
  console.log(`tree panel at 80%: ${before.toFixed(0)} → ${after.toFixed(0)} px (dragged 60)`);
  await shot(host, "25b-host-zoomed-resize");
  await host.getByTitle("Reset to 100%").click();

  // The tree panel is each viewer's own.
  await frameOf(host).getByTitle("Hide files").click();
  await wait(500);
  console.log(
    "after host hides its tree, guest tree visible:",
    await frameOf(guest).getByRole("treeitem").first().isVisible(),
  );
  await shot(host, "26-host-tree-hidden");

  // View-only guests see open files, but get no tree.
  await host.getByLabel("Guest access").selectOption("view");
  await pick(host, "docs/adr/0001-host-relayed-star-topology.md").catch(async () => {
    await frameOf(host).getByTitle("Show files").click();
    await pick(host, "docs/adr/0001-host-relayed-star-topology.md");
  });
  await frameOf(guest).getByText("The host's browser is the only door").first().waitFor({
    timeout: 10000,
  });
  console.log(
    "view guest: tree toggle shown:",
    await frameOf(guest)
      .getByTitle(/files$/)
      .count(),
    "treeitems:",
    await frameOf(guest).getByRole("treeitem").count(),
  );
  await shot(guest, "27-view-guest");
  await host.getByLabel("Guest access").selectOption("edit");
}
await browser.close();
