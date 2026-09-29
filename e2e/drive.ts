// Exploratory multi-user drive: a host and a guest in separate browser
// contexts against the running dev server + `canvas serve`. Screenshots land
// in $OUT (default /tmp/canvas-shots).
import { chromium, type Page } from "playwright";

const hostLink = process.argv[2]!;
const out = process.env.OUT ?? "/tmp/canvas-shots";
const u = new URL(hostLink);
const f = new URLSearchParams(u.hash.slice(1));
let guestLink = "";

const browser = await chromium.launch();
const open = async (url: string, name: string, color: string) => {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: "dark",
  });
  // Runs in every frame; sandboxed ones (HTML previews) have no storage.
  await context.addInitScript(
    ([n, c]) => {
      try {
        localStorage.setItem("canvas.identity", JSON.stringify({ name: n, color: c }));
      } catch {}
    },
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
// The guest link as a host shares it. On a relay (ADR 0008) it carries a
// guest token only `canvas serve` can sign.
await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await host.getByRole("button", { name: "Copy guest link" }).click();
guestLink = await host.evaluate(() => navigator.clipboard.readText());
const g = new URLSearchParams(new URL(guestLink).hash.slice(1));
const guest = await open(guestLink, "Ada", "#3b82f6");
await guest.getByText("host online").waitFor({ timeout: 30000 });
console.log("guest sees host");

/** The host answers every tool permission the agent asks for until it goes idle. */
async function approveUntilIdle(host: Page, guest: Page) {
  let shots = 0;
  const deadline = Date.now() + Number(process.env.IDLE_MS ?? 240_000);
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
/** The board's frames as the host's doc has them. */
const framesOf = (page: Page) =>
  page.evaluate(() => {
    const frames: Array<Record<string, any>> = [];
    (window as any).room.doc
      .getMap("frames")
      .forEach((map: any, id: string) => frames.push({ id, ...map.toJSON() }));
    return frames;
  });
const brief = (f: Record<string, any>) =>
  `${f.id} ${f.type} "${f.title}" ${f.path ?? f.url ?? f.agent ?? ""}` +
  `${f.lines ? ` L${f.lines.start}-${f.lines.end}` : ""} @${f.x},${f.y} ${f.w}x${f.h}` +
  `${f.origin ? ` origin=${f.origin}` : ""}`;

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

/** Send a prompt from the host and wait for the agent to finish. */
async function ask(frame: ReturnType<Page["locator"]>, text: string) {
  await frame.locator(".cm-content").click();
  await host.keyboard.type(text);
  await host.keyboard.press("Control+Enter");
  await approveUntilIdle(host, guest);
  await new Promise((r) => setTimeout(r, 800));
  const tools = await frame
    .locator("button .font-mono.truncate")
    .evaluateAll((els) => els.map((el) => el.textContent));
  console.log("tool calls:", tools.join(", "));
  console.log("reply:", (await frame.locator(".prose-canvas").last().innerText()).slice(0, 600));
}

// Agents use the board tools (finding 06). Run against a project with auth
// code, e.g. the scratch repo of finding 07.
if (step === "tools") {
  const kind = process.env.AGENT ?? "claude";
  // A clean board: the agent's cluster should be what this step puts there.
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, kind);
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0 });
  // Another cluster far away, which the agent should leave alone.
  const other = await addFrame(host, "Files");
  const otherId = (await other.getAttribute("data-frame"))!;
  await place(host, otherId, { x: 3000, y: 0, path: "README.md", title: "README.md" });
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });

  await ask(
    frame,
    "Show me the files relevant to authentication in this project on the board, at the relevant lines. Keep your reply short.",
  );
  let frames = await framesOf(host);
  console.log("board after 1st prompt:\n  " + frames.map(brief).join("\n  "));
  const opened = frames.filter((f) => f.origin === self);
  console.log(`opened by the agent: ${opened.length}; README untouched:`, frames.find((f) => f.id === otherId)?.x === 3000);
  await guest.locator(`[data-frame="${opened[0]?.id}"]`).waitFor({ timeout: 10000 });
  console.log("guest sees the agent's frames:", await guest.locator("[data-frame-type=file]").count());
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await guest.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 1500));
  await shot(host, `30-${kind}-host-auth-files`);
  await shot(guest, `30-${kind}-guest-auth-files`);
  if (opened[0]) await host.locator(`[data-frame="${opened[0].id}"]`).screenshot({ path: `${out}/31-${kind}-file-lines.png` });

  await ask(
    frame,
    "Open src/auth/password.ts at the lines of the function that verifies a password; close the login.ts frame; and open a terminal in a new row below your frame. Short reply.",
  );
  frames = await framesOf(host);
  console.log("board after 2nd prompt:\n  " + frames.map(brief).join("\n  "));
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 1000));
  await shot(host, `32-${kind}-host-after-close`);
  const lined = frames.find((f) => f.origin === self && f.lines);
  if (lined) {
    await new Promise((r) => setTimeout(r, 1000));
    await host
      .locator(`[data-frame="${lined.id}"]`)
      .screenshot({ path: `${out}/34-${kind}-highlighted-lines.png` });
  }
  await frame.screenshot({ path: `${out}/33-${kind}-thread.png` });
}

// After a `canvas serve` restart the board tools reach the reloaded session.
if (step === "resume") {
  const frame = host.locator("[data-frame-type=agent]").last();
  await frame.waitFor({ timeout: 10000 });
  await ask(frame, "Call view_board and tell me how many frames are in your cluster. One line.");
}

// A file frame with a line range opens there, highlighted, for everyone.
// Needs a long file in the project: LONG=path (e.g. a copy of room.ts).
if (step === "lines") {
  const path = process.env.LONG ?? "src/big.ts";
  const frame = await addFrame(host, "Files");
  const id = (await frame.getAttribute("data-frame"))!;
  await place(host, id, { path, title: path, lines: { start: 400, end: 412 }, x: 0, y: 0, h: 700 });
  for (const page of [host, guest]) {
    await page.getByTitle("Reset to 100%").click();
    await page.locator(`[data-frame="${id}"] diffs-container`).waitFor({ timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500));
    const visible = await page.locator(`[data-frame="${id}"]`).evaluate((section) => {
      const scroller = section.querySelector("diffs-container")!.closest(".overflow-auto")!;
      const line = section.querySelector("diffs-container")!.shadowRoot!.querySelector('[data-line="400"]');
      if (!line) return "line 400 not rendered";
      const s = scroller.getBoundingClientRect();
      const l = line.getBoundingClientRect();
      return `line 400 at ${Math.round(l.top - s.top)}px of ${Math.round(s.height)}px`;
    });
    console.log(`${page === host ? "host" : "guest"}: ${visible}`);
    await page.locator(`[data-frame="${id}"]`).screenshot({ path: `${out}/35-lines-${page === host ? "host" : "guest"}.png` });
  }
}

// Dragging and resizing follow the layout rules; Alt opts out.
if (step === "layout") {
  const ids: string[] = [];
  for (const [i, path] of ["README.md", "src/db.ts", "src/routes/products.ts"].entries()) {
    const frame = await addFrame(host, "Files");
    const id = (await frame.getAttribute("data-frame"))!;
    ids.push(id);
    await place(host, id, { path, title: path, x: i * 1400, y: i === 1 ? 900 : 0, w: 600, h: 400 + i * 60 });
  }
  const [a, b, c] = ids as [string, string, string];
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 500));
  const frame = async (id: string) => (await framesOf(host)).find((f) => f.id === id)!;
  const scale = async () => (await host.locator(`[data-frame="${a}"]`).boundingBox())!.width / (await frame(a)).w;

  /** Drag a frame by its header so its top-left lands at board (x, y). */
  const drag = async (id: string, x: number, y: number, alt = false) => {
    const f = await frame(id);
    const k = await scale();
    const box = (await host.locator(`[data-frame="${id}"]`).boundingBox())!;
    const from = { x: box.x + 14 * k, y: box.y + 18 * k };
    if (alt) await host.keyboard.down("Alt");
    await host.mouse.move(from.x, from.y);
    await host.mouse.down();
    await host.mouse.move(from.x + ((x - f.x) * k) / 2, from.y + ((y - f.y) * k) / 2, { steps: 5 });
    await host.mouse.move(from.x + (x - f.x) * k, from.y + (y - f.y) * k, { steps: 5 });
    await new Promise((r) => setTimeout(r, 300));
    const ghost = await host.locator("[data-snap-preview]").isVisible();
    await shot(host, `4${alt ? "2" : "0"}-drag-${id}`);
    await host.mouse.up();
    if (alt) await host.keyboard.up("Alt");
    await new Promise((r) => setTimeout(r, 400));
    return ghost;
  };

  // B dropped roughly right of A: snaps into A's row, at A's height.
  const A = await frame(a);
  let ghost = await drag(b, A.x + A.w + 40, A.y + 30);
  let B = await frame(b);
  console.log(`snap right: ghost=${ghost} B=${brief(B)} expect x=${A.x + A.w + 24} y=${A.y} h=${A.h}`);

  // C dropped under A: a new row.
  ghost = await drag(c, A.x + 20, A.y + A.h + 40);
  let C = await frame(c);
  console.log(`snap below: ghost=${ghost} C=${brief(C)} expect x=${A.x} y=${A.y + A.h + 24}`);

  // Resizing A's height: B follows, C's row moves down.
  const k = await scale();
  const corner = (await host.locator(`[data-frame="${a}"] .cursor-nwse-resize`).boundingBox())!;
  await host.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await host.mouse.down();
  await host.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2 + 100 * k, { steps: 6 });
  await host.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const [A2, B2, C2] = [await frame(a), await frame(b), await frame(c)];
  console.log(`resize row: A.h=${A2.h} B.h=${B2.h} C.y=${C2.y} (was ${C.y})`);
  await shot(host, "41-resized-row");

  // C moved into A's row, left of A: reorders the row.
  await drag(c, A2.x - 200, A2.y + 20);
  const order = (await framesOf(host))
    .filter((f) => ids.includes(f.id))
    .sort((p, q) => p.y - q.y || p.x - q.x)
    .map((f) => `${f.path}@${f.x},${f.y} ${f.w}x${f.h}`);
  console.log("after dropping C left of A:", order.join(" | "));

  // With Alt: dropped where it is, no snap.
  B = await frame(b);
  ghost = await drag(b, B.x + 60, B.y + 90, true);
  const B3 = await frame(b);
  console.log(`alt drag: ghost=${ghost} moved to ${B3.x},${B3.y} (expect ${B.x + 60},${B.y + 90}, give or take rounding)`);
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 400));
  await shot(host, "43-final");
  await guest.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 400));
  await shot(guest, "43-guest-final");
}
// Arranging frames: inserting between frames shows a line, a frame leaving
// (moved or removed) closes its gap, Shift drags a cluster, the title field
// is only as wide as the title.
if (step === "arrange") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const add = async (x: number, y: number) => {
    const id = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
    await place(host, id, { x, y, w: 600, h: 400 });
    return id;
  };
  const [a, b, c, d] = [await add(0, 0), await add(624, 0), await add(1248, 0), await add(0, 424)];
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle(500);
  const frame = async (id: string) => (await framesOf(host)).find((f) => f.id === id)!;
  const at = async (...ids: string[]) =>
    Promise.all(ids.map(async (id) => `${(await frame(id)).x},${(await frame(id)).y}`));
  const scale = async () =>
    (await host.locator(`[data-frame="${a}"]`).boundingBox())!.width / (await frame(a)).w;

  /** Drag a frame by its header so its top-left lands at board (x, y); the preview seen before letting go. */
  const drag = async (id: string, x: number, y: number, name: string, key?: "Shift") => {
    const f = await frame(id);
    const k = await scale();
    const box = (await host.locator(`[data-frame="${id}"]`).boundingBox())!;
    const from = { x: box.x + 14 * k, y: box.y + 18 * k };
    await host.mouse.move(from.x, from.y);
    await host.mouse.down();
    if (key) await host.keyboard.down(key);
    await host.mouse.move(from.x + ((x - f.x) * k) / 2, from.y + ((y - f.y) * k) / 2, { steps: 5 });
    await host.mouse.move(from.x + (x - f.x) * k, from.y + (y - f.y) * k, { steps: 5 });
    await settle(300);
    const ghost = host.locator("[data-snap-preview]");
    const preview = (await ghost.isVisible()) ? await ghost.getAttribute("data-snap-preview") : null;
    const line = preview === "insert" ? await ghost.boundingBox() : null;
    await shot(host, `50-${name}`);
    await host.mouse.up();
    if (key) await host.keyboard.up(key);
    await settle();
    return { preview, line };
  };

  // D (alone in the second row) between A and B: a vertical line, then A D B C, no second row.
  let seen = await drag(d, 330, 10, "insert-in-row");
  check(
    seen.preview === "insert" && seen.line!.height > seen.line!.width,
    `between A and B: ${seen.preview} line ${JSON.stringify(seen.line)}`,
  );
  check(
    (await at(a, d, b, c)).join(" ") === "0,0 624,0 1248,0 1872,0",
    `row reads A D B C: ${await at(a, d, b, c)}`,
  );

  // D dropped just right of C, the row's end: the outline, not a line.
  seen = await drag(d, 1872 + 40, 20, "append-to-row");
  check(seen.preview === "place", `end of the row: ${seen.preview}`);
  check(
    (await at(a, b, c, d)).join(" ") === "0,0 624,0 1248,0 1872,0",
    `D left its place, B and C closed up: ${await at(a, b, c, d)}`,
  );

  // A new row under A, then D between the rows: a horizontal line.
  const e = await add(0, 424);
  seen = await drag(d, 20, 250, "insert-between-rows");
  check(
    seen.preview === "insert" && seen.line!.width > seen.line!.height,
    `between the rows: ${seen.preview} line ${JSON.stringify(seen.line)}`,
  );
  check(
    (await at(a, b, c, d, e)).join(" ") === "0,0 624,0 1248,0 0,424 0,848",
    `D a row of its own between, E pushed down: ${await at(a, b, c, d, e)}`,
  );

  // Removing B closes the row; removing D, alone in its row, pulls E up.
  await host.locator(`[data-frame="${b}"]`).getByTitle("Remove frame").click();
  await settle();
  check((await at(c)).join() === "624,0", `B removed, C moved into its place: ${await at(c)}`);
  await host.locator(`[data-frame="${d}"]`).getByTitle("Remove frame").click();
  await settle();
  check((await at(e)).join() === "0,424", `D removed, E's row moved up: ${await at(e)}`);

  // A snapped next to a frame far away: C closes the gap it leaves.
  const far = await add(4000, 0);
  await drag(a, 4000 + 600 + 30, 10, "move-to-other-cluster");
  check(
    (await at(a, c)).join(" ") === "4624,0 0,0",
    `A next to the far frame, C at the row's start: ${await at(a, c)}`,
  );

  // Shift: C drags E along, keeping their offsets, no snap preview.
  seen = await drag(c, 200, 1500, "shift-cluster", "Shift");
  check(seen.preview === null, `no preview with Shift: ${seen.preview}`);
  check(
    (await at(c, e, far)).join(" ") === "200,1500 200,1924 4000,0",
    `the cluster moved as one, the far one stayed: ${await at(c, e, far)}`,
  );

  // The title field is as wide as the title; the header beside it drags.
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle();
  const header = host.locator(`[data-frame="${c}"] > div`).first();
  const input = host.locator(`[data-frame="${c}"]`).getByLabel("Frame title");
  const [hb, ib] = [(await header.boundingBox())!, (await input.boundingBox())!];
  check(ib.width < hb.width / 3, `title ${Math.round(ib.width)}px of a ${Math.round(hb.width)}px header`);
  const before = await frame(c);
  const grab = { x: ib.x + ib.width + (hb.width - ib.width) / 3, y: hb.y + hb.height / 2 };
  await host.mouse.move(grab.x, grab.y);
  await host.mouse.down();
  await host.mouse.move(grab.x, grab.y - 60, { steps: 5 });
  await host.mouse.up();
  await settle();
  check(
    (await frame(c)).y !== before.y,
    `dragged by the header's empty part: y ${before.y} → ${(await frame(c)).y}`,
  );
  await input.click();
  check(await input.evaluate((el) => el === document.activeElement), "clicking the title edits it");
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle();
  await shot(host, "51-final");
}
// Frame focus: who occupies a frame drives its scroll for everyone following.
// Needs a long file and a long markdown file: LONG (default src/big.ts), MD
// (default docs/notes.md).
if (step === "focus") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const a = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  const b = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  await place(host, a, { path: process.env.LONG ?? "src/big.ts", title: "big.ts", x: 0, y: 0, w: 640, h: 480 });
  await place(host, b, { path: process.env.MD ?? "docs/notes.md", title: "notes.md", x: 700, y: 0, w: 640, h: 480 });
  for (const page of [host, guest]) {
    await page.locator(`[data-frame="${a}"] diffs-container`).waitFor({ timeout: 10000 });
    await page.locator(`[data-frame="${b}"] .prose-canvas`).waitFor({ timeout: 10000 });
    await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  }
  await settle();

  const frame = (page: Page, id: string) => page.locator(`[data-frame="${id}"]`);
  const state = (page: Page, id: string) =>
    frame(page, id).evaluate((el) => ({
      occupant: el.getAttribute("data-occupant"),
      following: el.hasAttribute("data-following"),
    }));
  /** The frame's main scroller: the code view's virtualizer, or the preview. */
  const scroller = (page: Page, id: string) =>
    frame(page, id).evaluate((el) => {
      const code = el.querySelector("diffs-container")?.closest(".overflow-auto");
      const node = (code ?? el.querySelector(".overflow-auto")) as HTMLElement;
      return Math.round(node.scrollTop);
    });
  const body = async (page: Page, id: string) => {
    const box = (await frame(page, id).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const press = async (page: Page, id: string) => {
    const at = await body(page, id);
    await page.mouse.click(at.x, at.y);
  };
  const wheel = async (page: Page, id: string, dy: number) => {
    const at = await body(page, id);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, dy);
  };

  // Host presses A: it's theirs; the guest sees them there and follows.
  await press(host, a);
  await settle();
  let h = await state(host, a);
  let g = await state(guest, a);
  check(h.occupant === "Karl" && !h.following, `host occupies A (${JSON.stringify(h)})`);
  check(g.occupant === "Karl" && g.following, `guest sees Karl in A, following (${JSON.stringify(g)})`);
  await shot(host, "50-focus-host-occupies");
  await shot(guest, "50-focus-guest-follows");

  // Host scrolls A: the guest's A goes along.
  await wheel(host, a, 1600);
  await settle(1000);
  let [hs, gs] = [await scroller(host, a), await scroller(guest, a)];
  check(hs > 0 && Math.abs(hs - gs) <= 2, `guest follows host's scroll in A (host ${hs}, guest ${gs})`);

  // Guest presses A: it stays Karl's. The guest scrolls: detached, just for them.
  await press(guest, a);
  await wheel(guest, a, -600);
  await settle();
  g = await state(guest, a);
  h = await state(host, a);
  check(g.occupant === "Karl" && !g.following, `guest scrolled away from Karl in A (${JSON.stringify(g)})`);
  check(h.occupant === "Karl", "host still occupies A");
  const guestOwn = await scroller(guest, a);
  await wheel(host, a, 1600);
  await settle(1000);
  [hs, gs] = [await scroller(host, a), await scroller(guest, a)];
  check(gs === guestOwn && hs !== gs, `detached guest keeps its own scroll (host ${hs}, guest ${gs})`);
  await shot(guest, "51-focus-guest-detached");

  // Guest clicks Karl's badge: following again.
  await frame(guest, a).locator("[data-occupant-badge]").click();
  await settle(1000);
  g = await state(guest, a);
  [hs, gs] = [await scroller(host, a), await scroller(guest, a)];
  check(g.following && Math.abs(hs - gs) <= 2, `badge click follows again (host ${hs}, guest ${gs})`);

  // Guest presses B: theirs now; the host follows their scroll in the preview.
  await press(guest, b);
  await settle();
  check((await state(host, b)).occupant === "Ada", "host sees Ada in B");
  await wheel(guest, b, 900);
  await settle(1000);
  [hs, gs] = [await scroller(host, b), await scroller(guest, b)];
  check(gs > 0 && Math.abs(hs - gs) <= 2, `host follows Ada's scroll in B (host ${hs}, guest ${gs})`);
  await shot(host, "52-focus-two-occupants");

  // Host presses B (taken): they hold nothing now, so A is free.
  await press(host, b);
  await settle();
  check((await state(guest, a)).occupant === null, "host pressing occupied B frees A");
  check((await state(guest, b)).occupant === "Ada", "B stays Ada's");

  // Guest presses the empty board: B is free.
  const boardBox = (await guest.locator("[data-board]").boundingBox())!;
  await guest.mouse.click(boardBox.x + 30, boardBox.y + boardBox.height - 30);
  await settle();
  check((await state(host, b)).occupant === null, "guest pressing the board frees B");

  // An agent occupies A (as the host does for a board tool call); a person takes over.
  await host.evaluate(([frameId]) => (window as any).room.claimForAgent("agent-x", frameId), [a]);
  await settle();
  g = await state(guest, a);
  check(g.occupant === "agent" && g.following, `guest sees the agent in A (${JSON.stringify(g)})`);
  await frame(guest, a).screenshot({ path: `${out}/53-focus-agent.png` });
  await press(guest, a);
  await settle();
  const agents = await host.evaluate(() => (window as any).room.awareness.getLocalState().agents);
  check((await state(host, a)).occupant === "Ada", "guest takes A over from the agent");
  check(agents.length === 0, `the agent's claim is dropped (${JSON.stringify(agents)})`);
  await host.evaluate(() => (window as any).room.claimForAgent("agent-x", "nope"));
  await host.evaluate(() => (window as any).room.releaseAgent("agent-x"));

  // A terminal: scrollback lines follow the occupant.
  const t = (await (await addFrame(host, "Terminal")).getAttribute("data-frame"))!;
  await place(host, t, { x: 0, y: 540, w: 640, h: 360 });
  for (const page of [host, guest]) await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle(1500);
  await press(host, t);
  await host.keyboard.type("seq 1 400\n");
  await settle(1500);
  const firstRow = (page: Page) =>
    frame(page, t).locator(".xterm-rows > div").first().innerText();
  const bottom = await firstRow(host);
  for (let i = 0; i < 10; i++) await wheel(host, t, -150);
  await settle(1000);
  const [ht, gt] = [await firstRow(host), await firstRow(guest)];
  check(
    ht !== bottom && ht === gt,
    `guest's terminal follows host's scrollback (bottom "${bottom}", host "${ht}", guest "${gt}")`,
  );
  await shot(guest, "54-focus-terminal");
}
// A file frame's tree panel follows its occupant: open or closed, its width,
// its folders, search and scroll (finding 18). Wants a repo with nested folders.
if (step === "focus-tree") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const a = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  await place(host, a, { path: "README.md", title: "README.md", x: 0, y: 0, w: 900, h: 600 });
  for (const page of [host, guest]) {
    await page.locator(`[data-frame="${a}"]`).getByText("hi").waitFor({ timeout: 10000 });
    await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  }
  await settle();

  const frame = (page: Page) => page.locator(`[data-frame="${a}"]`);
  /** The tree panel as a viewer sees it; null when closed. */
  const tree = (page: Page) =>
    frame(page).evaluate((el) => {
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
  const following = (page: Page) => frame(page).evaluate((el) => el.hasAttribute("data-following"));
  const row = (page: Page, path: string) =>
    frame(page).locator(`[data-item-path="${path}"]:not([data-file-tree-sticky-row])`).first();
  const same = async (what: string) => {
    const [h, g] = [await tree(host), await tree(guest)];
    check(JSON.stringify(h) === JSON.stringify(g), `${what} (host ${JSON.stringify(h)}, guest ${JSON.stringify(g)})`);
    return h;
  };

  // A new files frame opens with its tree. Host hides it (pressing A claims it): the guest's goes.
  check((await tree(guest)) !== null, "guest's tree starts open");
  await frame(host).getByTitle("Hide files").click();
  await settle();
  check(await following(guest), "guest follows Karl in A");
  check((await tree(guest)) === null, "guest's tree closes with Karl's");

  // Host opens it again: the guest's opens too, as wide.
  await frame(host).getByTitle("Show files").click();
  await settle();
  const opened = await same("guest's tree opens with Karl's");
  check(!!opened, "the tree is open");

  // Host opens folders: the guest's open too.
  for (const path of ["src/", "src/alpha/", "src/alpha/two/", "src/gamma/", "src/gamma/three/"]) {
    await row(host, path).click();
    await settle(250);
  }
  await settle();
  const folders = await same("guest's folders follow Karl's");
  check(!!folders?.expanded.includes("src/gamma/three/"), "folders are open");
  await shot(guest, "180-tree-follows-folders");

  // Host scrolls the tree.
  const at = (await row(host, "src/").boundingBox())!;
  await host.mouse.move(at.x + 20, at.y + 5);
  await host.mouse.wheel(0, 300);
  await settle();
  const scrolled = await same("guest's tree scrolls with Karl's");
  check((scrolled?.top ?? 0) > 0, "the tree is scrolled");

  // Host collapses a folder, then searches.
  await host.mouse.wheel(0, -1000);
  await settle(300);
  await row(host, "src/alpha/").click();
  await settle();
  await same("guest's folder closes with Karl's");
  const search = frame(host).locator("[data-file-tree-search-input]");
  await search.click();
  await search.fill("f7");
  await settle();
  const searched = await same("guest searches what Karl searches");
  check(searched?.search === "f7", "the search is shown");
  await shot(guest, "181-tree-follows-search");
  await search.fill("");
  await host.keyboard.press("Escape");
  await settle();

  // Guest opens a folder themselves: detached, their tree is their own.
  await row(guest, "src/beta/").click();
  await settle();
  check(!(await following(guest)), "guest opening a folder stops following");
  await row(host, "src/gamma/").click();
  await settle();
  const [h, g] = [await tree(host), await tree(guest)];
  check(
    !!g?.expanded.includes("src/beta/") && !!g.expanded.includes("src/gamma/") && !h?.expanded.includes("src/gamma/"),
    `detached guest keeps their own folders (host ${h?.expanded}, guest ${g?.expanded})`,
  );

  // Guest clicks Karl's badge: following again, the tree is Karl's again.
  await frame(guest).locator("[data-occupant-badge]").click();
  await settle();
  check(await following(guest), "badge click follows again");
  await same("guest's tree is Karl's again");

  // Host widens the panel.
  const handle = frame(host).locator('[data-slot="resizable-handle"]');
  const hb = (await handle.boundingBox())!;
  await host.mouse.move(hb.x + 1, hb.y + hb.height / 2);
  await host.mouse.down();
  await host.mouse.move(hb.x + 120, hb.y + hb.height / 2, { steps: 8 });
  await host.mouse.up();
  await settle();
  const wider = await same("guest's panel widens with Karl's");
  check((wider?.width ?? 0) > (opened?.width ?? 0), `the panel is wider (${opened?.width} → ${wider?.width})`);

  // Host hides the tree: the guest's closes.
  await frame(host).getByTitle("Hide files").click();
  await settle();
  check((await tree(guest)) === null, "guest's tree closes with Karl's");
}
// A real agent occupies the frame it opens until its turn ends; its thread
// scrolls with whoever occupies the agent frame.
if (step === "focus-agent") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "claude");
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0, h: 560 });
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });
  await frame.locator(".cm-content").click();
  await host.keyboard.type(
    `Open ${process.env.LONG ?? "src/big.ts"} at lines 400-410 on the board, then explain those lines in about 300 words.`,
  );
  await host.keyboard.press("Control+Enter");
  // While it works, the guest sees the agent in the frame it opened.
  let seen: string | null = null;
  const deadline = Date.now() + Number(process.env.IDLE_MS ?? 240_000);
  while (Date.now() < deadline) {
    const allow = host.locator("[data-permission-kind=allow_once]").first();
    if (await allow.isVisible().catch(() => false)) await allow.click();
    const occupied = guest.locator("[data-frame-type=file][data-occupant]");
    if (!seen && (await occupied.count())) {
      seen = await occupied.first().getAttribute("data-occupant");
      await shot(guest, "55-focus-agent-working");
    }
    if (await frame.getByText("idle", { exact: true }).isVisible()) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 1000));
  const title = await frame.locator("input[aria-label='Frame title']").inputValue();
  check(seen === title, `guest saw the agent (${seen}) in the file it opened (expected ${title})`);
  check(
    (await guest.locator("[data-frame-type=file][data-occupant]").count()) === 0,
    "the agent left the frame when its turn ended",
  );

  // The host occupies the agent frame and scrolls its thread up; the guest follows.
  for (const page of [host, guest]) await page.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 800));
  const thread = (page: Page) => page.locator(`[data-frame="${self}"] [data-frame-body]`).first();
  const box = (await thread(host).boundingBox())!;
  await host.mouse.click(box.x + box.width / 2, box.y + 20);
  await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await host.mouse.wheel(0, -120);
  await new Promise((r) => setTimeout(r, 1000));
  const top = (page: Page) => thread(page).evaluate((el) => Math.round(el.scrollTop));
  const [ht, gt] = [await top(host), await top(guest)];
  const max = await thread(host).evaluate((el) => el.scrollHeight - el.clientHeight);
  check(ht < max - 40 && Math.abs(ht - gt) <= 2, `guest follows the thread (host ${ht}, guest ${gt}, end ${max})`);
  await shot(guest, "56-focus-thread-follow");
}
// Needs a project with PAGE (default page.html, see finding 09) in DIR and a
// dev server on the host's loopback at LOCAL (default http://127.0.0.1:5199/).
if (step === "preview") {
  const dir = process.env.DIR ?? "/tmp/canvas-preview";
  const page = process.env.PAGE ?? "page.html";
  const local = process.env.LOCAL ?? "http://127.0.0.1:5199/";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });

  // An HTML file of the shared set renders for everyone, scripts sandboxed.
  const file = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  await place(host, file, { path: page, title: page, x: 0, y: 0, w: 640, h: 420 });
  const doc = (p: Page) => p.locator(`[data-frame="${file}"] iframe`).contentFrame();
  for (const [p, who] of [[host, "host"], [guest, "guest"]] as const) {
    await doc(p).locator("#probe").getByText("scripts run").waitFor({ timeout: 10000 });
    const probe = await doc(p).locator("#probe").innerText();
    check(
      probe === "scripts run; storage blocked; parent blocked",
      `${who}: the page's script runs, sandboxed (${probe})`,
    );
    check(
      (await p.locator(`[data-frame="${file}"] iframe`).getAttribute("sandbox")) === "allow-scripts",
      `${who}: sandbox is allow-scripts only`,
    );
  }
  await Bun.write(
    `${dir}/${page}`,
    (await Bun.file(`${dir}/${page}`).text()).replace("Hello preview", "Hello again"),
  );
  await doc(guest).getByText("Hello again").waitFor({ timeout: 10000 });
  check(true, "guest: the preview follows the file on disk");

  // Loopback: the host's frame loads it, a guest's shows a notice instead.
  const web = (await (await addFrame(host, "Browser")).getAttribute("data-frame"))!;
  await place(host, web, { url: local, title: "local", x: 700, y: 0, w: 640, h: 420 });
  const bar = (p: Page) => p.locator(`[data-frame="${web}"] input[name=url]`);
  await host.locator(`[data-frame="${web}"] iframe[src="${local}"]`).waitFor({ timeout: 10000 });
  const hostText = await host
    .locator(`[data-frame="${web}"] iframe`)
    .contentFrame()
    .locator("body")
    .innerText();
  check(hostText.includes("local dev server"), "host: loads its own localhost");
  await guest
    .locator(`[data-frame="${web}"]`)
    .getByText("is on the host's machine")
    .waitFor({ timeout: 10000 });
  check(
    (await guest.locator(`[data-frame="${web}"] iframe`).count()) === 0,
    "guest: no iframe for the host's localhost",
  );
  for (const p of [host, guest]) await p.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle();
  await shot(host, "60-preview-host");
  await shot(guest, "60-preview-guest");

  // A typed loopback address gets http, not https.
  await bar(guest).fill("localhost:5199");
  await bar(guest).press("Enter");
  await settle();
  check(
    (await bar(host).inputValue()) === "http://localhost:5199",
    `a typed loopback address gets http (${await bar(host).inputValue()})`,
  );

  // Anything but http(s), written straight into the board, loads nowhere.
  await guest.evaluate(
    ([frameId]) => (window as any).room.doc.getMap("frames").get(frameId).set("url", "javascript:alert(1)"),
    [web],
  );
  for (const [p, who] of [[host, "host"], [guest, "guest"]] as const) {
    await p
      .locator(`[data-frame="${web}"]`)
      .getByText("Only http and https URLs load.")
      .waitFor({ timeout: 10000 });
    check((await p.locator(`[data-frame="${web}"] iframe`).count()) === 0, `${who}: no iframe for javascript:`);
  }
}
// Agents show what only belongs on the board as scratch files (ADR 0005),
// without writing into the project. Run against the shop repo of finding 07
// in DIR; AGENT picks the agent (default claude).
if (step === "scratch") {
  const dir = process.env.DIR ?? "/tmp/canvas-scratch-demo";
  const kind = process.env.AGENT ?? "claude";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const gitStatus = () =>
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir }).stdout.toString().trim();
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, kind);
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0 });
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });
  const before = gitStatus();

  await ask(
    frame,
    "On the board, show us a short markdown write-up of how login works in this project, and a " +
      "small HTML page that visualises the login flow as boxes and arrows. Keep your reply short.",
  );
  const frames = await framesOf(host);
  console.log("board:\n  " + frames.map(brief).join("\n  "));
  const scratch = frames.filter((f) => f.type === "file" && f.path?.startsWith("canvas:scratch/"));
  const md = scratch.find((f) => /\.md$/.test(f.path));
  const html = scratch.find((f) => /\.html?$/.test(f.path));
  check(!!md && !!html, `a markdown and an HTML scratch file (${scratch.map((f) => f.path)})`);
  check(gitStatus() === before, `the project is untouched (${gitStatus() || "clean"})`);
  const onDisk = Bun.spawnSync(["ls", `${dir}/.canvas/scratch`]).stdout.toString().trim();
  console.log("in .canvas/scratch:", onDisk.split("\n").join(", "));
  const boardJson = JSON.stringify(frames);
  check(boardJson.length < 4000, `the board holds paths, not content (${boardJson.length} bytes)`);

  for (const [p, who] of [[host, "host"], [guest, "guest"]] as const) {
    if (md) {
      const heading = p.locator(`[data-frame="${md.id}"] .prose-canvas h1, [data-frame="${md.id}"] .prose-canvas h2`);
      await heading.first().waitFor({ timeout: 10000 });
      check(true, `${who}: the write-up renders (${await heading.first().innerText()})`);
    }
    if (html) {
      const body = p.locator(`[data-frame="${html.id}"] iframe`).contentFrame().locator("body");
      await body.waitFor({ timeout: 10000 });
      const text = (await body.innerText()).replace(/\s+/g, " ").slice(0, 80);
      check(text.length > 0, `${who}: the visualisation renders (${text})`);
    }
  }
  for (const p of [host, guest]) await p.locator("[data-hud]").getByTitle("Fit board to view").click();
  await new Promise((r) => setTimeout(r, 1500));
  await shot(host, `70-${kind}-scratch-host`);
  await shot(guest, `70-${kind}-scratch-guest`);

  // Another turn rewrites the write-up in place: the frame follows.
  if (md) {
    const was = await guest.locator(`[data-frame="${md.id}"] .prose-canvas`).innerText();
    await ask(
      frame,
      `Add a section "Open questions" with one question to the write-up at ${md.path}. Short reply.`,
    );
    await guest
      .locator(`[data-frame="${md.id}"] .prose-canvas`)
      .getByText("Open questions")
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    const now = await guest.locator(`[data-frame="${md.id}"] .prose-canvas`).innerText();
    check(now !== was && now.includes("Open questions"), "guest: the rewritten write-up shows live");
    const after = await framesOf(host);
    check(
      after.filter((f) => f.path?.startsWith("canvas:scratch/")).length === scratch.length,
      "rewritten in place, no new frame",
    );
    check(gitStatus() === before, "the project is still untouched");
    await shot(guest, `71-${kind}-scratch-rewritten`);
  }
  await frame.screenshot({ path: `${out}/72-${kind}-scratch-thread.png` });
}
// An agent gathers a topic in one file frame with a list (ADR 0005): its
// write-up, repo files at display paths and lines, a visualisation. People
// click through it; each can switch to all files. Same project as `scratch`.
if (step === "lists") {
  const dir = process.env.DIR ?? "/tmp/canvas-scratch-demo";
  const kind = process.env.AGENT ?? "claude";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const wait = (ms = 800) => new Promise((r) => setTimeout(r, ms));
  const gitStatus = () =>
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir }).stdout.toString().trim();
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, kind);
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0 });
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });
  const before = gitStatus();

  await ask(
    frame,
    "Show us everything about login in this project in one file frame we can click through: a " +
      "short write-up first, then the relevant source files grouped in folders by layer, at the " +
      "relevant lines, and a small HTML visualisation of the flow last. Keep your reply short.",
  );
  let frames = await framesOf(host);
  console.log("board:\n  " + frames.map(brief).join("\n  "));
  const listed = frames.filter((f) => f.type === "file" && f.files?.length);
  check(listed.length === 1, `one file frame with a list (${listed.length})`);
  const target = listed[0]!;
  const list: Array<{ display: string; path: string; lines?: { start: number; end: number } }> =
    target.files;
  console.log(
    "list:\n  " +
      list
        .map((e) => `${e.display} → ${e.path}${e.lines ? ` L${e.lines.start}-${e.lines.end}` : ""}`)
        .join("\n  "),
  );
  check(
    frames.filter((f) => f.type === "file" && f.origin === self).length === 1,
    "no frame per file",
  );
  check(list.some((e) => e.path.startsWith("canvas:scratch/")), "the list mixes in scratch files");
  check(list.some((e) => !e.path.startsWith("canvas:scratch/")), "and project files");
  check(gitStatus() === before, `the project is untouched (${gitStatus() || "clean"})`);

  const frameOf = (p: Page) => p.locator(`[data-frame="${target.id}"]`);
  const rows = (p: Page) =>
    frameOf(p)
      .locator("[role=treeitem][data-item-type=file]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")));
  const selectedRow = (p: Page) =>
    frameOf(p).locator("[role=treeitem][aria-selected=true]").getAttribute("data-item-path");
  for (const [p, who] of [[host, "host"], [guest, "guest"]] as const) {
    await frameOf(p).locator("[role=treeitem]").first().waitFor({ timeout: 10000 });
    const shown = await rows(p);
    check(
      JSON.stringify(shown) === JSON.stringify(list.map((e) => e.display)),
      `${who}: the tree is the list, in the agent's order (${shown.join(" | ")})`,
    );
  }
  // Whatever the agent built: a list with folders opens all of them, in the list's order.
  const fixed = [
    { display: "Zeta/b.ts", path: "src/auth/session.ts" },
    { display: "Alpha/a.ts", path: "src/auth/password.ts", lines: { start: 2, end: 4 } },
    { display: "Zeta/a.ts", path: "src/routes/login.ts" },
    { display: "top.md", path: "README.md" },
  ];
  await place(host, target.id, { files: fixed });
  await wait();
  const fixedRows = await rows(guest);
  // A folder sorts where its first entry is: Zeta's two files stay together.
  const expected = ["Zeta/b.ts", "Zeta/a.ts", "Alpha/a.ts", "top.md"];
  check(
    JSON.stringify(fixedRows) === JSON.stringify(expected),
    `folders all open, in the list's order (${fixedRows.join(" | ")})`,
  );
  await place(host, target.id, { files: list });
  await wait();

  const lined = list.find((e) => e.lines && !e.path.startsWith("canvas:scratch/"));
  if (lined) {
    const text = await frameOf(guest)
      .locator(`[role=treeitem][data-item-path="${lined.display}"]`)
      .innerText();
    check(text.includes(`L${lined.lines!.start}`), `the lines show as a badge (${text.replace(/\s+/g, " ")})`);
  }
  for (const p of [host, guest]) await p.locator("[data-hud]").getByTitle("Fit board to view").click();
  await wait(1500);
  await shot(host, `80-${kind}-list-host`);
  await shot(guest, `80-${kind}-list-guest`);

  // The guest clicks through: the frame follows for everyone, at the entry's lines.
  const pick = lined ?? list[1]!;
  await frameOf(guest).locator(`[role=treeitem][data-item-path="${pick.display}"]`).click();
  await wait();
  frames = await framesOf(host);
  const now = frames.find((f) => f.id === target.id)!;
  check(
    now.path === pick.path && JSON.stringify(now.lines ?? null) === JSON.stringify(pick.lines ?? null),
    `guest picks ${pick.display}: the frame shows ${now.path} ${JSON.stringify(now.lines)}`,
  );
  check(now.title === target.title, `the list keeps its title (${now.title})`);
  check((await selectedRow(host)) === pick.display, "the host's list selects it too");
  await frameOf(host).screenshot({ path: `${out}/81-${kind}-list-picked.png` });

  // All files, for one viewer: the file shown is selected where it lives.
  await frameOf(guest).getByTitle("Show all files").click();
  await wait();
  check((await selectedRow(guest)) === pick.path, `guest's full tree selects ${pick.path}`);
  check(
    (await rows(host)).length === list.length,
    "the host still sees the list (the toggle is per viewer)",
  );
  await frameOf(guest).screenshot({ path: `${out}/82-${kind}-all-files.png` });
  await frameOf(guest).getByTitle("Show the list").click();
  await wait();

  // A view guest sees the list, can't click through it, and gets no full tree.
  await host.getByLabel("Guest access").selectOption("view");
  await wait(1500);
  const other = list.find((e) => e.display !== pick.display)!;
  check((await rows(guest)).length === list.length, "view guest: sees the list");
  await frameOf(guest).locator(`[role=treeitem][data-item-path="${other.display}"]`).click();
  await wait();
  check(
    (await framesOf(host)).find((f) => f.id === target.id)!.path === pick.path,
    "view guest: a click doesn't change the frame",
  );
  check((await selectedRow(guest)) === pick.display, "view guest: the selection snaps back");
  check((await frameOf(guest).getByTitle("Show all files").count()) === 0, "view guest: no full tree");
  await frameOf(guest).screenshot({ path: `${out}/83-${kind}-view-guest-list.png` });
  await host.getByLabel("Guest access").selectOption("edit");
}

// Comments on a file frame (ADR 0006): people write them from the gutter,
// they stay with the frame, follow their lines as the file changes, and only
// their author or the host changes them. Against the project of finding 13.
if (step === "comments") {
  const dir = process.env.DIR ?? "/tmp/canvas-comments";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const wait = (ms = 800) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await addFrame(host, "Files");
  const id = (await frame.getAttribute("data-frame"))!;
  await place(host, id, { x: 0, y: 0, w: 900, h: 640 });
  const frameOf = (page: Page) => page.locator(`[data-frame="${id}"]`);
  const pick = async (page: Page, path: string) => {
    await frameOf(page).getByPlaceholder("Search").fill(path.split("/").at(-1)!);
    await frameOf(page).locator(`[role=treeitem][data-item-path="${path}"]`).click();
    await frameOf(page).getByPlaceholder("Search").fill("");
  };
  const comments = () =>
    host.evaluate(
      (frameId) => [...(window as any).room.doc.getMap(`comments:${frameId}`).values()],
      id,
    ) as Promise<Array<Record<string, any>>>;
  /** Hover a line, click the gutter's "+", write, save. */
  const comment = async (page: Page, line: number, body: string) => {
    const at = frameOf(page).locator(`[data-line="${line}"]`).first();
    await at.waitFor({ timeout: 10000 });
    const box = (await at.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
    await frameOf(page).locator("[data-utility-button]").click();
    await frameOf(page).getByLabel("Comment", { exact: true }).fill(body);
    await page.keyboard.press("Control+Enter");
  };
  const card = (page: Page, text: string) =>
    frameOf(page).locator("[data-comment]", { hasText: text });

  await pick(host, "src/values.ts");
  await frameOf(guest).locator('[data-line="10"]').first().waitFor({ timeout: 10000 });
  check((await frameOf(host).locator("[data-comments-button]").count()) === 0, "no comments: no header button");

  await comment(host, 10, "Why is this **ten**?");
  await card(guest, "Why is this").waitFor({ timeout: 10000 });
  check(
    (await card(guest, "Why is this").locator("strong").innerText()) === "ten",
    "the guest sees the host's comment, markdown rendered",
  );

  // The guest comments on a range: select 20–22 by the line numbers, then "+".
  await frameOf(guest).locator('[data-column-number="20"]').first().click();
  await frameOf(guest).locator('[data-column-number="22"]').first().click({ modifiers: ["Shift"] });
  await comment(guest, 22, "guest note");
  await card(host, "guest note").waitFor({ timeout: 10000 });
  let all = await comments();
  const guestNote = all.find((c) => c.body === "guest note")!;
  check(guestNote.start === 20 && guestNote.end === 22, `the guest's range: L${guestNote.start}-${guestNote.end}`);
  check(guestNote.quote.split("\n").length === 3, "it quotes its three lines");
  check(guestNote.author.name === "Ada" && guestNote.author.kind === "person", "by Ada");
  await wait();
  await shot(host, "100-host-comments");
  await shot(guest, "100-guest-comments");

  // Their own, and the host everyone's.
  const canEdit = async (page: Page, text: string) => {
    await card(page, text).hover();
    return card(page, text).getByTitle("Edit comment").isVisible();
  };
  check(!(await canEdit(guest, "Why is this")), "the guest can't edit the host's comment");
  check(await canEdit(guest, "guest note"), "the guest can edit their own");
  check(await canEdit(host, "guest note"), "the host can edit the guest's");
  await card(guest, "guest note").getByTitle("Edit comment").click();
  await frameOf(guest).getByLabel("Comment", { exact: true }).fill("guest note, edited");
  await frameOf(guest).getByRole("button", { name: "Save" }).click();
  await card(host, "guest note, edited").waitFor({ timeout: 10000 });
  check(true, "an edit reaches the host");

  // The header button and the tree.
  const button = frameOf(guest).locator("[data-comments-button]");
  check((await button.innerText()).trim() === "2", "the header counts 2 comments");
  const row = frameOf(host).locator('[role=treeitem][data-item-path="src/values.ts"]');
  await frameOf(host).getByPlaceholder("Search").fill("values.ts");
  check((await row.innerText()).includes("● 2"), `the tree badges the file: ${await row.innerText()}`);
  await frameOf(host).getByPlaceholder("Search").fill("");

  // Another file: the comments stay with the frame; picking one goes back to it.
  await pick(host, "docs/readme.md");
  await frameOf(guest).locator(".prose-canvas h1").waitFor({ timeout: 10000 });
  check((await button.innerText()).trim() === "2", "they stay when the frame shows another file");
  await button.click();
  await guest.locator("[data-comments-popover]").waitFor();
  await shot(guest, "101-guest-comments-popover");
  await guest.locator("[data-comments-popover] [data-comment-link]", { hasText: "guest note" }).click();
  await frameOf(host).locator('[data-line="22"]').first().waitFor({ timeout: 10000 });
  let now = (await framesOf(host)).find((f) => f.id === id)!;
  check(
    now.path === "src/values.ts" && now.lines?.start === 20 && now.lines?.end === 22,
    `picking a comment opens its file at its lines: ${now.path} L${now.lines?.start}-${now.lines?.end}`,
  );

  // A markdown file's comment shows in the source: picking it switches from the preview.
  await pick(host, "docs/readme.md");
  await host.waitForTimeout(500);
  await host.evaluate((frameId) => {
    const map = (window as any).room.doc.getMap("frames").get(frameId);
    map.set("view", "source");
  }, id);
  await comment(host, 5, "a list item");
  await pick(host, "src/values.ts");
  await frameOf(host).locator("[data-comments-button]").click();
  await host.locator("[data-comments-popover] [data-comment-link]", { hasText: "a list item" }).click();
  await card(guest, "a list item").waitFor({ timeout: 10000 });
  now = (await framesOf(host)).find((f) => f.id === id)!;
  check(now.path === "docs/readme.md" && (now.view ?? null) === null && !!now.lines, "the markdown file opens in source");

  // The file changes on disk: comments follow their lines, or go outdated.
  await pick(host, "src/values.ts");
  await card(host, "Why is this").waitFor({ timeout: 10000 });
  const file = `${dir}/src/values.ts`;
  // From git: a run that failed half-way leaves the file changed.
  const original = Bun.spawnSync(["git", "show", "HEAD:src/values.ts"], { cwd: dir }).stdout.toString();
  await Bun.write(file, original);
  await Bun.write(file, `// one\n// two\n// three\n${original}`);
  await frameOf(guest).locator('[data-comment-line="13"]').waitFor({ timeout: 10000 });
  all = await comments();
  check(all.find((c) => c.body.startsWith("Why"))!.start === 13, "lines moved down 3: the comment follows");
  await Bun.write(file, `// one\n// two\n// three\n${original.replace("value10 = 10", "value10 = 100")}`);
  await card(guest, "Why is this").locator("text=outdated").waitFor({ timeout: 10000 });
  await wait();
  all = await comments();
  check(all.find((c) => c.body.startsWith("Why"))!.outdated === true, "its line changed: outdated");
  check(
    (await frameOf(guest).locator('[data-comment-line="0"] [data-comment]').count()) === 1,
    "an outdated comment shows above the first line",
  );
  await shot(guest, "102-guest-outdated");
  await Bun.write(file, original);
  await frameOf(guest).locator('[data-comment-line="10"]').waitFor({ timeout: 10000 });
  await wait();
  all = await comments();
  check(!all.find((c) => c.body.startsWith("Why"))!.outdated, "the line is back: no longer outdated");

  // The tree toolbar: only files with comments.
  await frameOf(host).getByTitle("Only files with comments").click();
  await wait();
  const rows = await frameOf(host)
    .locator("[role=treeitem][data-item-type=file]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")));
  check(
    JSON.stringify(rows.sort()) === JSON.stringify(["docs/readme.md", "src/values.ts"]),
    `filtered tree: ${rows.join(", ")}`,
  );
  await shot(host, "103-host-filtered-tree");
  await frameOf(host).getByTitle("Show every file").click();
  await frameOf(host).getByTitle("Hide files").click();
  await frameOf(host).getByTitle("Show files").waitFor();
  check(true, "hiding the tree puts Show files in the header");
  await frameOf(host).getByTitle("Show files").click();

  // Deleting: the host deletes the guest's.
  await card(host, "guest note, edited").hover();
  await card(host, "guest note, edited").getByTitle("Delete comment").click();
  await wait();
  check((await card(guest, "guest note").count()) === 0, "the host deletes the guest's comment");

  // View guests read comments, but can't write them.
  await host.getByLabel("Guest access").selectOption("view");
  await wait(1500);
  const box = (await frameOf(guest).locator('[data-line="30"]').first().boundingBox())!;
  await guest.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
  await wait(300);
  check((await frameOf(guest).locator("[data-utility-button]").count()) === 0, "view guest: no +");
  await host.getByLabel("Guest access").selectOption("edit");

  // Comments are the frame's: a new frame has none, and they go with it.
  await frameOf(host).locator('[role=treeitem][data-item-path="src/values.ts"]').waitFor();
  await frameOf(host)
    .locator('[role=treeitem][data-item-path="src/values.ts"]')
    .click({ modifiers: ["ControlOrMeta"] });
  await wait();
  const other = (await framesOf(host)).find((f) => f.id !== id)!;
  check(
    (await host.locator(`[data-frame="${other.id}"] [data-comments-button]`).count()) === 0,
    "a file opened in a new frame has no comments",
  );
  await frameOf(host).getByTitle("Remove frame").click();
  await wait();
  check((await comments()).length === 0, "removing the frame removes its comments");
}

// Agents read comments with view_frame and write their own (ADR 0006).
// Same project as `comments`.
if (step === "comments-agent") {
  const kind = process.env.AGENT ?? "claude";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, kind);
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0 });
  const files = await addFrame(host, "Files");
  const id = (await files.getAttribute("data-frame"))!;
  await place(host, id, { x: 484, y: 0, w: 820, h: 620, path: "src/values.ts", title: "values.ts" });
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
      id: "k1", path: "src/values.ts", start: 20, end: 22, author, at: Date.now(),
      quote: [20, 21, 22].map((n) => `export const value${n} = ${n}; // line ${n}`).join("\n"),
      body: "What is the sum of the three values on these lines?",
    });
    map.set("k2", {
      id: "k2", path: "src/deep/greet.ts", start: 2, end: 2, author, at: Date.now(),
      quote: "  return `hi ${name}`;", body: "Which greeting word does this use?",
    });
  }, id);
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });

  await ask(
    frame,
    "Karl left comments in the files frame next to you. Read them and answer each in your reply. " +
      "Then leave a comment of your own in that frame on line 40 of src/values.ts, saying which " +
      "constant it exports. Keep it short.",
  );
  let all = await comments();
  const reply = (await frame.locator(".prose-canvas").allInnerTexts()).join("\n").toLowerCase();
  check(reply.includes("63"), "it read the range comment (20 + 21 + 22 = 63)");
  check(reply.includes("hi"), "it read the comment on the other file");
  const mine = all.find((c) => c.author.kind === "agent");
  check(
    !!mine && mine.start === 40 && mine.quote.includes("value40") && mine.author.frame === self,
    `its comment: L${mine?.start} by ${mine?.author.name}: ${mine?.body}`,
  );
  await guest.locator(`[data-frame="${id}"] [data-comment="${mine?.id}"]`).waitFor({ timeout: 10000 });
  check(true, "the guest sees the agent's comment");
  await host.locator(`[data-frame="${id}"]`).screenshot({ path: `${out}/104-${kind}-agent-comment.png` });

  await ask(
    frame,
    "Change your comment to say just 'checked'. Then delete Karl's comment about greet.ts. Short reply.",
  );
  all = await comments();
  check(all.find((c) => c.id === mine?.id)?.body === "checked", "it edited its comment");
  check(!!all.find((c) => c.id === "k2"), "it can't delete Karl's comment");

  await ask(
    frame,
    "Show Karl's comment about src/values.ts on the board: point that frame at it. Short reply.",
  );
  const now = (await framesOf(host)).find((f) => f.id === id)!;
  check(
    now.path === "src/values.ts" && now.lines?.start === 20 && now.lines?.end === 22,
    `it points the frame at the comment: ${now.path} L${now.lines?.start}-${now.lines?.end}`,
  );
  await frame.screenshot({ path: `${out}/105-${kind}-thread.png` });
}

// Page and canvas serve of different releases: both host and guest are told.
// Run the dev server with VITE_CANVAS_VERSION and a staged release of the CLI
// (scripts/build-release.ts) of another version; EXPECT is the skew.
if (step === "version") {
  const expected = process.env.EXPECT ?? "page-older";
  for (const [name, page] of [
    ["host", host],
    ["guest", guest],
  ] as const) {
    const notice = page.locator("[data-version-notice]");
    await notice.waitFor({ timeout: 10000 });
    const skew = await notice.getAttribute("data-version-notice");
    console.log(`${skew === expected ? "ok  " : "FAIL"} ${name}: ${await notice.innerText()}`);
    if (skew !== expected) process.exitCode = 1;
    await shot(page, `95-${name}-${skew}`);
  }
  await host.locator("[data-version-notice]").getByTitle("Dismiss").click();
  const gone = (await host.locator("[data-version-notice]").count()) === 0;
  console.log(`${gone ? "ok  " : "FAIL"} dismissed`);
  if (!gone) process.exitCode = 1;
}

// One host tab at a time: a second one takes over, "Use here" takes it back.
if (step === "takeover") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const connected = (page: Page) => page.getByText("connected to canvas serve");
  const replaced = (page: Page) => page.locator("[data-host-elsewhere]");

  const second = await open(hostLink, "Karl", "#f97316");
  await connected(second).waitFor({ timeout: 15000 });
  await replaced(host).waitFor({ timeout: 10000 });
  check(true, "the first tab steps down when a second one opens");
  const toolbar = host.locator("[data-hud]").getByRole("button", { name: "Agent" });
  check((await toolbar.count()) === 0, "the replaced tab is read-only");
  await shot(host, "90-first-tab-replaced");

  // Guests follow the tab that has canvas serve: a frame a guest adds reaches it.
  await guest.getByText("host online").waitFor({ timeout: 30000 });
  const frame = await addFrame(guest, "Files");
  const id = await frame.getAttribute("data-frame");
  await second.locator(`[data-frame="${id}"]`).waitFor({ timeout: 10000 });
  check(true, "a guest's edit reaches the second tab");

  await host.getByRole("button", { name: "Use here" }).click();
  await connected(host).waitFor({ timeout: 15000 });
  await replaced(second).waitFor({ timeout: 10000 });
  check(true, "Use here takes the board back");
  await shot(second, "91-second-tab-replaced");

  // Neither tab reconnects by itself: they don't take it from each other.
  await new Promise((r) => setTimeout(r, 5000));
  check(await connected(host).isVisible(), "the first tab is still the host 5 s later");
  check(await replaced(second).isVisible(), "the second tab still waits");
  await guest.getByText("host online").waitFor({ timeout: 30000 });
  check(true, "the guest sees the host again");
}
// Links to places on the board (ADR 0007): chips in markdown, lines and
// headings for the one who clicks, Back, web links in a new tab, linked HTML
// pages in one frame, a page's own posts ignored, a guest's deep link. Wants
// the project of finding 14.
if (step === "links") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const presence = (p: Page) =>
    p.evaluate(() => (window as any).room.awareness.getLocalState() as any);
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
    const YMap = frames.constructor;
    const readme = new YMap();
    const frame = { type: "file", path: "README.md", title: "README.md", x: 40, y: 40, w: 640, h: 560, z: 1 };
    for (const [k, v] of Object.entries(frame)) readme.set(k, v);
    frames.set("readme01", readme);
  });
  const readme = host.locator('[data-frame="readme01"]');
  const chip = (text: string) => readme.locator("[data-board-link]", { hasText: text });
  await chip("a.ts:120-125").waitFor({ timeout: 15000 });
  const chips = await readme.locator("[data-board-link]").allInnerTexts();
  check(chips.includes("src/b.ts:40"), `inline code naming a file is a chip (${chips})`);
  const codes = await readme.locator("code").allInnerTexts();
  check(codes.includes("foo.bar") && codes.includes("src/nope.ts:3"), "other code stays code");
  await shot(host, "95-links-readme");

  const secrets = new URL(host.url()).hash;
  await chip("a.ts:120-125").click();
  await host.waitForTimeout(1200);
  const a = (await framesOf(host)).find((f) => f.path === "src/a.ts");
  check(a?.view === "source" && !a.lines, "a file no frame shows opens beside, in source, no shared lines");
  const mine = await presence(host);
  check(mine.selection?.start === 120 && mine.selection?.end === 125, "the lines are my selection");
  check(mine.focus?.frameId === a?.id, "and I occupy the frame");
  check(new URL(host.url()).hash.startsWith(secrets), "the page URL keeps the room's secrets");
  await shot(host, "96-links-lines");
  const fit = () => host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await fit();

  await chip("Bottom").click();
  await host.waitForTimeout(600);
  const scrolled = () => readme.locator("[data-frame-body]").evaluate((e) => e.scrollTop);
  check((await scrolled()) > 0, "a heading of the same file scrolls to it");
  await readme.locator("[data-frame-body]").evaluate((e) => (e.scrollTop = 0));
  await fit();
  await chip("Install").click();
  await host.waitForTimeout(1200);
  const guide = (await framesOf(host)).find((f) => f.path === "docs/guide.md");
  const guideTop = await host
    .locator(`[data-frame="${guide?.id}"] [data-frame-body]`)
    .evaluate((e) => e.scrollTop);
  check(!!guide && guideTop > 0, "a heading of another file opens it there");
  await host.goBack();
  await host.waitForTimeout(800);
  check((await scrolled()) > 0, "Back goes to the heading before");

  await fit();
  const [tab] = await Promise.all([
    host.context().waitForEvent("page", { timeout: 5000 }).catch(() => null),
    readme.locator("a", { hasText: "example" }).click(),
  ]);
  check(!!tab && new URL(host.url()).pathname === "/", "a web link opens a tab, the board stays");
  await tab?.close();

  await fit();
  await chip("index").click();
  await host.waitForTimeout(2500); // the page's own posts go out meanwhile
  let frames = await framesOf(host);
  const page = frames.find((f) => f.path === "pages/index.html")!;
  check(!frames.some((f) => f.path === "src/b.ts"), "the page's own posts go nowhere");
  const iframe = host.locator(`[data-frame="${page.id}"] iframe`).contentFrame();
  await iframe.locator("#two").click();
  await host.waitForTimeout(800);
  frames = await framesOf(host);
  check(frames.find((f) => f.id === page.id)?.path === "pages/two.html", "a page's link opens in its frame");
  await iframe.locator("#one").click();
  await host.waitForTimeout(2500);
  check((await presence(host)).focus?.frameId === page.id, "nor right after a click");
  await iframe.locator("#anchor").click();
  await host.waitForTimeout(400);
  check((await iframe.locator("#down").count()) === 1, "an in-page anchor stays in the page");
  await iframe.locator("body").evaluate(() => scrollTo(0, 0));
  await iframe.locator("#code").click();
  await host.waitForTimeout(1000);
  check((await presence(host)).selection?.start === 60, "a page's link to lines of a file");
  await shot(host, "97-links-page");

  const u = new URL(guestLink);
  await guest.goto(`${u.origin}/?room=${u.searchParams.get("room")}${u.hash}&frame=${a?.id}&lines=30-33`);
  await guest.getByText("host online").waitFor({ timeout: 30000 });
  await guest.waitForTimeout(3000);
  const theirs = await presence(guest);
  check(theirs.selection?.start === 30 && theirs.selection?.end === 33, "a guest's deep link to lines");
  await shot(guest, "98-links-guest-deep");
}

// The connection dialog (finding 15): what host and guest see when it works,
// and the headline for each way it fails — WebRTC blocked (no ICE path), and
// the signalling relays blocked.
if (step === "connection") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const dialog = async (page: Page) => {
    await page.locator("[data-connection-indicator]").click();
    return page.locator("[data-connection-dialog]");
  };
  const headline = (page: Page) => page.locator("[data-connection-headline]");
  const waitHeadline = async (page: Page, title: string, ms = 30000) => {
    try {
      await headline(page).getByText(title).waitFor({ timeout: ms });
      return true;
    } catch {
      console.log("  headline:", await headline(page).innerText().catch(() => "?"));
      return false;
    }
  };

  for (const [name, page] of [
    ["host", host],
    ["guest", guest],
  ] as const) {
    const d = await dialog(page);
    check(await waitHeadline(page, "Connected to one peer"), `${name}: connected to one peer`);
    // The route comes from WebRTC stats, read once a second while open.
    await d.getByText(/direct|relayed/).first().waitFor({ timeout: 5000 });
    check(true, `${name}: the peer's route shows`);
    await d.locator("[data-network-test]").waitFor({ timeout: 10000 });
    check(true, `${name}: network test ran (${await d.locator("[data-network-test]").innerText()})`);
    await d.getByText("Details").click();
    await d.getByText("Peer connections").waitFor();
    // The report is for sending around: it must not carry the link's secrets.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await d.getByRole("button", { name: "Copy report" }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const parsed = JSON.parse(text) as { peers: unknown[]; log: unknown[] };
    check(parsed.peers.length === 1 && parsed.log.length > 0, `${name}: the report has peers and the log`);
    const secrets = [f.get("k")!, f.get("token")!, f.get("pk")!];
    check(!secrets.some((secret) => text.includes(secret)), `${name}: the report has no keys or tokens`);
    await shot(page, `96-${name}-connection`);
    await page.keyboard.press("Escape");
  }

  // WebRTC blocked: only TURN candidates allowed, and no TURN server — as on
  // a network that blocks UDP. Peers find each other, then fail.
  const blocked = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
  await blocked.addInitScript(() => {
    const Native = RTCPeerConnection;
    // @ts-expect-error replacing the constructor
    window.RTCPeerConnection = function (config?: RTCConfiguration) {
      return new Native({ ...config, iceServers: [], iceTransportPolicy: "relay" });
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  });
  const noRtc = await blocked.newPage();
  await noRtc.goto(guestLink);
  await dialog(noRtc);
  check(
    await waitHeadline(noRtc, "Found peers, but couldn't connect to them", 60000),
    "WebRTC blocked: found peers but couldn't connect",
  );
  check(
    (await noRtc.locator("[data-connection-indicator]").getAttribute("data-status")) === "blocked",
    "WebRTC blocked: the indicator turns red",
  );
  await shot(noRtc, "97-webrtc-blocked");
  await blocked.close();

  // Signalling blocked: every relay socket is refused.
  const offline = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
  await offline.routeWebSocket(/^wss:/, (ws) => ws.close());
  const noRelay = await offline.newPage();
  await noRelay.goto(guestLink);
  await dialog(noRelay);
  check(
    await waitHeadline(noRelay, "No signalling relay reachable", 20000),
    "relays blocked: no signalling relay reachable",
  );
  await shot(noRelay, "98-relays-blocked");
  await offline.close();
}
// A board on a `canvas relay` (ADR 0008), run with `serve --relay … [--relay-via signal]`.
// A guest that can reach neither the Nostr relays nor (transport) WebRTC
// joins, edits the board both ways and runs a request on the host; a token
// that doesn't verify is refused.
if (step === "relay") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const via = g.get("via");
  check(via === "transport" || via === "signal", `the guest link names the relay (${via})`);
  const headline = (page: Page) => page.locator("[data-connection-headline]");

  await host.locator("[data-connection-indicator]").click();
  await headline(host).getByText("Connected to one peer").waitFor({ timeout: 15000 });
  const dialog = host.locator("[data-connection-dialog]");
  if (via === "transport") await dialog.getByText("through canvas relay").first().waitFor();
  else await dialog.getByText(/direct|relayed via TURN/).first().waitFor({ timeout: 10000 });
  check(true, `host: connected to the guest (${via})`);
  await dialog.getByText("Details").click();
  await shot(host, `99-relay-${via}-host`);
  await host.keyboard.press("Escape");
  check(
    Boolean(g.get("rt")?.includes(".g.")) && !hostLink.includes("rt="),
    "the guest link carries a guest token; the host link none",
  );

  // Locked down: no Nostr relays, and for the transport no WebRTC at all.
  const locked = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
  await locked.routeWebSocket(/^wss:/, (ws) => ws.close());
  if (via === "transport")
    await locked.addInitScript(() => {
      // @ts-expect-error replacing the constructor
      window.RTCPeerConnection = function () {
        throw new Error("WebRTC is blocked here");
      };
    });
  await locked.addInitScript(() =>
    localStorage.setItem("canvas.identity", JSON.stringify({ name: "Locked", color: "#22c55e" })),
  );
  const guarded = await locked.newPage();
  guarded.on("pageerror", (e) => console.log("[locked] pageerror", e.message));
  await guarded.goto(guestLink);
  await guarded.getByText("host online").waitFor({ timeout: 30000 });
  check(true, "a guest without Nostr" + (via === "transport" ? " or WebRTC" : "") + " reaches the host");

  const fromHost = await addFrame(host, "Files");
  const hostFrameId = await fromHost.getAttribute("data-frame");
  await guarded.locator(`[data-frame="${hostFrameId}"]`).waitFor({ timeout: 10000 });
  check(true, "the host's board edit reaches it");
  const fromGuest = await addFrame(guarded, "Files");
  const guestFrameId = await fromGuest.getAttribute("data-frame");
  await host.locator(`[data-frame="${guestFrameId}"]`).waitFor({ timeout: 10000 });
  check(true, "its board edit reaches the host");

  // A request: typing into a terminal runs on the host's machine.
  await host.getByLabel("Guest access").selectOption("trusted");
  const term = await addFrame(host, "Terminal");
  const termId = await term.getAttribute("data-frame");
  await guarded.locator(`[data-frame="${termId}"] .xterm`).waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));
  await guarded.locator(`[data-frame="${termId}"] .xterm`).click();
  await guarded.keyboard.type("echo relay-$((6*7))\n");
  await host.locator(`[data-frame="${termId}"]`).getByText("relay-42").first().waitFor({ timeout: 15000 });
  await guarded.locator(`[data-frame="${termId}"]`).getByText("relay-42").first().waitFor({ timeout: 15000 });
  check(true, "its terminal input runs on the host, and the output comes back");
  await guarded.locator("[data-connection-indicator]").click();
  await headline(guarded).waitFor();
  await guarded.waitForTimeout(500);
  await shot(guarded, `99-relay-${via}-locked-guest`);
  await locked.close();

  // A token that doesn't verify: the relay refuses it.
  const forged = guestLink.replace(/rt=([^&]+)/, (_, t: string) => `rt=${t.slice(0, -4)}AAAA`);
  const strangerContext = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
  const stranger = await strangerContext.newPage();
  await stranger.goto(forged);
  await stranger.locator("[data-connection-indicator]").click();
  const refused = via === "transport" ? "Can't reach the relay" : "No signalling relay reachable";
  await headline(stranger).getByText(refused).waitFor({ timeout: 20000 });
  check(true, `a forged token is refused: "${refused}"`);
  await shot(stranger, `99-relay-${via}-forged`);
  await strangerContext.close();
}
// Drawing frames (ADR 0009): Excalidraw under the board's zoom, host and guest
// drawing into one drawing at once, undo that stays yours, view guests.
if (step === "drawing") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const elements = (p: Page, id: string) =>
    p.evaluate(
      (frameId) =>
        [...(window as any).room.doc.getMap(`drawing:${frameId}`).values()].filter(
          (e: any) => !e.isDeleted,
        ),
      id,
    ) as Promise<Array<Record<string, any>>>;
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await addFrame(host, "Drawing");
  const id = (await frame.getAttribute("data-frame"))!;
  await place(host, id, { x: 0, y: 0 });
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await guest.locator("[data-hud]").getByTitle("Fit board to view").click();
  // Not 100%: Excalidraw must draw under the board's zoom.
  await host.locator("[data-hud]").getByTitle("Zoom out").click();
  const scale = async (p: Page) =>
    Number(await p.locator("[data-board]").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--board-scale")));
  const s = await scale(host);
  console.log("host board scale", s);
  await guest.locator(`[data-frame="${id}"]`).getByText("Double-click to draw.").waitFor({ timeout: 10000 });
  check(true, "the guest sees the empty drawing");

  // Host: a rectangle, dragged over 200×160 screen pixels.
  await host.locator(`[data-frame="${id}"] [data-drawing]`).dblclick({ position: { x: 20, y: 300 } });
  const editor = host.locator(`[data-frame="${id}"] [data-drawing-editor] .excalidraw`);
  await editor.waitFor({ timeout: 20000 });
  await host.waitForTimeout(800);
  const box = (await host.locator(`[data-frame="${id}"] [data-drawing-editor]`).boundingBox())!;
  await host.mouse.click(box.x + box.width - 60, box.y + box.height - 120);
  await host.keyboard.press("r");
  const drag = async (p: Page, x0: number, y0: number, x1: number, y1: number) => {
    await p.mouse.move(x0, y0);
    await p.mouse.down();
    await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
    await p.mouse.move(x1, y1, { steps: 6 });
    await p.mouse.up();
  };
  // Right of the style panel, which opens on the left with a tool.
  await drag(host, box.x + 260, box.y + 140, box.x + 460, box.y + 300);
  await host.waitForTimeout(500);
  await shot(host, "119-drawing-host-drew");
  let all = await elements(host, id);
  const rect = all.find((e) => e.type === "rectangle");
  const near = (a: number, b: number) => Math.abs(a - b) <= 3;
  check(
    !!rect && near(rect.width, 200 / s) && near(rect.height, 160 / s) && near(rect.x, 260 / s),
    `the rectangle is where the pointer drew it at ${Math.round(s * 100)}%: ` +
      `${Math.round(rect?.x)},${Math.round(rect?.y)} ${Math.round(rect?.width)}×${Math.round(rect?.height)}, ` +
      `want ${Math.round(260 / s)},${Math.round(140 / s)} ${Math.round(200 / s)}×${Math.round(160 / s)}`,
  );
  await guest.waitForFunction(
    (frameId) => document.querySelector(`[data-frame="${frameId}"] [data-drawing-picture] svg path`),
    id,
    { timeout: 10000 },
  );
  const theirs = (await elements(guest, id)).find((e) => e.type === "rectangle");
  check(theirs?.width === rect?.width, "the guest has it, at its final size");
  await shot(host, "120-drawing-host-editing");
  await shot(guest, "120-drawing-guest-picture");

  // Guest edits too, while the host still is: an ellipse.
  await guest.locator(`[data-frame="${id}"] [data-drawing-edit]`).click();
  const theirEditor = guest.locator(`[data-frame="${id}"] [data-drawing-editor] .excalidraw`);
  await theirEditor.waitFor({ timeout: 20000 });
  await guest.waitForTimeout(800);
  const gbox = (await guest.locator(`[data-frame="${id}"] [data-drawing-editor]`).boundingBox())!;
  await guest.mouse.click(gbox.x + gbox.width - 60, gbox.y + gbox.height - 120);
  await guest.keyboard.press("o");
  await drag(guest, gbox.x + 560, gbox.y + 120, gbox.x + 720, gbox.y + 240);
  await guest.waitForTimeout(800);
  all = await elements(host, id);
  check(all.some((e) => e.type === "ellipse"), "the guest's ellipse reaches the host");
  await shot(host, "121-drawing-host-sees-guest");
  await shot(guest, "121-drawing-guest-editing");

  // Undo is the host's own: its rectangle goes, the guest's ellipse stays.
  await host.keyboard.press("Control+z");
  await host.waitForTimeout(800);
  all = await elements(guest, id);
  check(
    !all.some((e) => e.type === "rectangle") && all.some((e) => e.type === "ellipse"),
    `undo takes back the host's rectangle only: ${all.map((e) => e.type).join(", ")}`,
  );
  await host.keyboard.press("Control+Shift+z");
  await host.waitForTimeout(800);
  all = await elements(guest, id);
  check(all.some((e) => e.type === "rectangle"), "redo brings it back");

  // Leaving: a click outside the frame.
  await host.mouse.click(5, 300);
  await guest.locator(`[data-frame="${id}"] [data-drawing-edit="done"]`).click();
  await host.locator(`[data-frame="${id}"] [data-drawing-picture] svg`).waitFor({ timeout: 10000 });
  check((await host.locator("[data-drawing-editor]").count()) === 0, "a click outside ends editing");
  await host.waitForTimeout(500);
  await shot(host, "122-drawing-host-picture");

  // The board zooms the picture like any frame.
  await host.locator("[data-hud]").getByTitle("Zoom in").click();
  await host.waitForTimeout(300);
  const before = (await host.locator(`[data-frame="${id}"] [data-drawing-picture]`).boundingBox())!;
  await host.locator("[data-hud]").getByTitle("Zoom out").click();
  await host.waitForTimeout(300);
  const after = (await host.locator(`[data-frame="${id}"] [data-drawing-picture]`).boundingBox())!;
  check(near(before.width / after.width, 1.25), "the picture zooms with the board");

  // View guests look, but don't draw.
  await host.getByLabel("Guest access").selectOption("view");
  await guest.waitForTimeout(1500);
  check(
    (await guest.locator(`[data-frame="${id}"] [data-drawing-edit]`).count()) === 0,
    "a view guest gets no Edit",
  );
  await guest.locator(`[data-frame="${id}"] [data-drawing]`).dblclick();
  await guest.waitForTimeout(800);
  check((await guest.locator("[data-drawing-editor]").count()) === 0, "nor an editor on double-click");
  await host.getByLabel("Guest access").selectOption("edit");

  // Removing the frame clears its drawing.
  await host.locator(`[data-frame="${id}"]`).getByTitle("Remove frame").click();
  await host.waitForTimeout(500);
  check((await elements(host, id)).length === 0, "removing the frame clears its elements");
}

// Agents and drawings (ADR 0009): view_frame shows the drawing as an image
// (Karl's freehand sketch is only in the image), draw adds a mermaid diagram,
// shapes bound to what is there, and removes. AGENT=claude|opencode.
if (step === "drawing-agent") {
  const kind = process.env.AGENT ?? "claude";
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const elements = (p: Page, id: string) =>
    p.evaluate(
      (frameId) =>
        [...(window as any).room.doc.getMap(`drawing:${frameId}`).values()].filter(
          (e: any) => !e.isDeleted,
        ),
      id,
    ) as Promise<Array<Record<string, any>>>;
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, kind);
  const self = (await frame.getAttribute("data-frame"))!;
  await place(host, self, { x: 0, y: 0 });
  const drawing = await addFrame(host, "Drawing");
  const id = (await drawing.getAttribute("data-frame"))!;
  await place(host, id, { x: 484, y: 0, h: 620 });
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await guest.locator("[data-hud]").getByTitle("Fit board to view").click();

  // Karl sketches a house with the pen.
  await host.locator(`[data-frame="${id}"] [data-drawing-edit]`).click();
  await host.locator(`[data-frame="${id}"] [data-drawing-editor] .excalidraw`).waitFor({ timeout: 20000 });
  await host.waitForTimeout(800);
  const box = (await host.locator(`[data-frame="${id}"] [data-drawing-editor]`).boundingBox())!;
  await host.mouse.click(box.x + box.width - 80, box.y + box.height - 140);
  await host.keyboard.press("p");
  const stroke = async (points: Array<[number, number]>) => {
    const at = ([x, y]: [number, number]) => [box.x + x, box.y + y] as const;
    await host.mouse.move(...at(points[0]!));
    await host.mouse.down();
    for (const point of points.slice(1)) await host.mouse.move(...at(point), { steps: 8 });
    await host.mouse.up();
  };
  const [l, t, w] = [260, 200, 160];
  await stroke([[l, t], [l, t + w], [l + w, t + w], [l + w, t], [l, t]]); // walls
  await stroke([[l - 20, t], [l + w / 2, t - 90], [l + w + 20, t]]); // roof
  await stroke([[l + 60, t + w], [l + 60, t + 90], [l + 100, t + 90], [l + 100, t + w]]); // door
  await host.keyboard.press("Escape");
  await host.mouse.click(5, 400);
  await host.waitForTimeout(500);
  check((await elements(host, id)).length === 3, "Karl's three strokes are in the drawing");
  await frame
    .locator("[data-agent-settings]")
    .getByText("starting agent…")
    .waitFor({ state: "detached", timeout: 30000 });

  await ask(
    frame,
    "Look at the drawing frame next to you. What did Karl sketch in it? Answer in one short sentence.",
  );
  const reply = (await frame.locator(".prose-canvas").last().innerText()).toLowerCase();
  check(/house|home|hut|cabin|building/.test(reply), `it saw the sketch in the image: ${reply.slice(0, 120)}`);

  await ask(
    frame,
    "Below Karl's sketch in that drawing, add a mermaid flowchart of how a guest's prompt reaches " +
      "an agent: guest browser -> host browser -> canvas serve -> agent. Short reply.",
  );
  let all = await elements(host, id);
  const labels = all
    .filter((e) => e.type === "text")
    .map((e) => e.text.toLowerCase().replace(/\s+/g, " "));
  check(
    labels.some((text) => text.includes("canvas serve")) && all.some((e) => e.type === "arrow"),
    `the flowchart is drawn: ${labels.join(" | ")}`,
  );
  const freehand = all.filter((e) => e.type === "freedraw");
  check(freehand.length === 3, "Karl's sketch is untouched");
  await guest.waitForFunction(
    (n) => (window as any).room.doc.getMap(`drawing:${n[0]}`).size >= n[1],
    [id, all.length] as const,
    { timeout: 10000 },
  );
  check(true, "the guest has the agent's elements");
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await host.waitForTimeout(1500);
  await shot(host, `125-${kind}-drawing-flowchart`);
  await shot(guest, `125-${kind}-drawing-flowchart-guest`);

  await ask(
    frame,
    "Next to the 'agent' box of your flowchart, add a red ellipse labelled 'you', with an arrow " +
      "from the agent box to it. Short reply.",
  );
  all = await elements(host, id);
  const you = all.find(
    (e) => e.type === "ellipse" && all.some((t) => t.containerId === e.id && /you/i.test(t.text)),
  );
  const arrow = you && all.find((e) => e.type === "arrow" && e.endBinding?.elementId === you.id);
  const from = arrow && all.find((e) => e.id === arrow.startBinding?.elementId);
  check(!!you, `the ellipse: ${you?.strokeColor} / ${you?.backgroundColor}`);
  check(
    !!from && all.some((t) => t.containerId === from.id && /agent/i.test(t.text)),
    "the arrow is bound from the agent box to it",
  );
  check(
    !!from && (from.boundElements ?? []).some((b: any) => b.id === arrow.id),
    "the agent box knows its new arrow, and keeps the old ones",
  );
  await host.waitForTimeout(1000);
  await host.locator(`[data-frame="${id}"]`).screenshot({ path: `${out}/126-${kind}-drawing-you.png` });

  await ask(frame, "Remove the ellipse and its arrow again. Short reply.");
  all = await elements(host, id);
  check(!all.some((e) => e.id === you?.id), "the ellipse is gone");
  check(all.filter((e) => e.type === "freedraw").length === 3, "Karl's sketch is still there");
  await frame.screenshot({ path: `${out}/127-${kind}-drawing-thread.png` });
}
// Panning over frames: the middle button and Space + drag pan from anywhere,
// without the frame under the pointer hearing of it.
if (step === "pan") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const term = (await (await addFrame(host, "Terminal")).getAttribute("data-frame"))!;
  const web = (await (await addFrame(host, "Browser")).getAttribute("data-frame"))!;
  const draw = (await (await addFrame(host, "Drawing")).getAttribute("data-frame"))!;
  await place(host, term, { x: 0, y: 0, w: 560, h: 380, z: 1 });
  await place(host, web, { x: 600, y: 0, w: 560, h: 380, z: 2 });
  await place(host, draw, { x: 0, y: 420, w: 560, h: 380, z: 3 });
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await host.locator(`[data-frame="${term}"] .xterm`).waitFor({ timeout: 10000 });
  await settle(800);

  const offset = () =>
    host.evaluate(() => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        (document.querySelector("[data-board] > div") as HTMLElement).style.transform,
      );
      return { x: Number(m?.[1]), y: Number(m?.[2]) };
    });
  // A point inside a frame's content, a quarter of the way in.
  const inside = async (id: string) => {
    const b = (await host.locator(`[data-frame="${id}"]`).boundingBox())!;
    return { x: b.x + b.width / 3, y: b.y + b.height / 2 };
  };
  const drag = async (at: { x: number; y: number }, button: "left" | "middle") => {
    const before = await offset();
    await host.mouse.move(at.x, at.y);
    await host.mouse.down({ button });
    await host.mouse.move(at.x + 60, at.y + 40, { steps: 5 });
    await host.mouse.move(at.x + 120, at.y + 80, { steps: 5 });
    await host.mouse.up({ button });
    await settle();
    const after = await offset();
    return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
  };
  const panned = (d: { dx: number; dy: number }) => d.dx === 120 && d.dy === 80;
  const still = (d: { dx: number; dy: number }) => d.dx === 0 && d.dy === 0;
  const occupant = (p: Page, id: string) =>
    p.locator(`[data-frame="${id}"]`).getAttribute("data-occupant");
  const z = (id: string) =>
    host.evaluate((f) => (window as any).room.doc.getMap("frames").get(f).get("z"), id);

  // The middle button, over a terminal: the board pans, the terminal isn't touched.
  let d = await drag(await inside(term), "middle");
  check(panned(d), `middle drag over a terminal pans the board (${d.dx},${d.dy})`);
  check((await occupant(host, term)) === null, "…without occupying it");
  check((await z(term)) === 1, "…or raising it");
  await settle(500);
  check((await occupant(guest, term)) === null, "…as the guest sees too");
  await shot(host, "130-pan-middle");

  // The left button, over a terminal, is the terminal's.
  d = await drag(await inside(term), "left");
  check(still(d), `left drag over a terminal leaves the board (${d.dx},${d.dy})`);
  // Typing into it, Space is a space.
  await host.locator(`[data-frame="${term}"] .xterm`).click();
  await host.keyboard.down("Space");
  const ready = () => host.locator("[data-board]").getAttribute("data-pan-ready");
  check((await ready()) === null, "Space typed into a terminal is the terminal's");
  await host.keyboard.up("Space");

  // Off the terminal (a press on the board), Space + drag pans over it.
  const board = (await host.locator("[data-board]").boundingBox())!;
  await host.mouse.click(board.x + board.width - 40, board.y + board.height - 40);
  await host.keyboard.down("Space");
  check((await ready()) === "true", "holding Space readies the board");
  const cursor = await host
    .locator(`[data-frame="${term}"] .xterm-screen`)
    .evaluate((el) => getComputedStyle(el).cursor);
  check(cursor === "grab", `…with a grab cursor over frames (${cursor})`);
  d = await drag(await inside(term), "left");
  check(panned(d), `Space + drag over a terminal pans the board (${d.dx},${d.dy})`);
  // Over a browser frame's page too: its iframe lets the press through.
  d = await drag(await inside(web), "left");
  check(panned(d), `Space + drag over a browser frame pans the board (${d.dx},${d.dy})`);
  await host.keyboard.up("Space");
  check((await ready()) === null, "letting go of Space ends it");
  d = await drag(await inside(term), "left");
  check(still(d), `…and the terminal has its left button back (${d.dx},${d.dy})`);

  // Leaving the window while holding Space doesn't leave the board panning.
  await host.keyboard.down("Space");
  await host.evaluate(() => window.dispatchEvent(new Event("blur")));
  check((await ready()) === null, "leaving the window lets go of Space");
  await host.keyboard.up("Space");

  // Space in the frame's title field is a space.
  const title = host.locator(`[data-frame="${term}"] input[aria-label="Frame title"]`);
  await title.click();
  await host.keyboard.press("End");
  await host.keyboard.type(" x");
  check((await title.inputValue()).endsWith(" x"), "Space in a title field types a space");
  await host.mouse.click(board.x + board.width - 40, board.y + board.height - 40);

  // The empty board still pans with the left button.
  d = await drag({ x: board.x + board.width - 60, y: board.y + 60 }, "left");
  check(panned(d), `left drag on the empty board pans it (${d.dx},${d.dy})`);

  // A drawing being edited keeps the middle button; panning elsewhere keeps it editing.
  await host.locator(`[data-frame="${draw}"] [data-drawing]`).dblclick();
  const editor = host.locator(`[data-frame="${draw}"] [data-drawing-editor] .excalidraw`);
  await editor.waitFor({ timeout: 20000 });
  await settle(800);
  d = await drag(await inside(draw), "middle");
  check(still(d), `middle drag in a drawing being edited is Excalidraw's (${d.dx},${d.dy})`);
  d = await drag(await inside(term), "middle");
  check(panned(d), `middle drag over a terminal pans (${d.dx},${d.dy})…`);
  check(await editor.isVisible(), "…and the drawing is still being edited");
  await shot(host, "131-pan-drawing");
}
if (step === "presence") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  for (const page of [host, guest]) await page.locator("[data-hud]").getByTitle("Reset to 100%").click();
  /** A peer's marker on the edge, relative to the board: its centre, or null. */
  const marker = (page: Page, name: string) =>
    page.evaluate((name) => {
      const el = document.querySelector(`[data-peer-marker="${name}"]`);
      if (!el) return null;
      const board = document.querySelector("[data-board]")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        x: Math.round(box.x + box.width / 2 - board.x),
        y: Math.round(box.y + box.height / 2 - board.y),
        w: Math.round(board.width),
        h: Math.round(board.height),
      };
    }, name);

  // Ada's mouse on her board; Karl looks at the same place, then pans far right.
  await guest.mouse.move(700, 450);
  await settle();
  check((await marker(host, "Ada")) === null, "Ada's cursor in view: no marker");
  await host.mouse.move(700, 450);
  for (let i = 0; i < 10; i++) await host.mouse.wheel(300, 0);
  await settle();
  let at = await marker(host, "Ada");
  check(!!at && at.x < 40 && Math.abs(at.y - at.h / 2) < 80, `Ada's marker on the left edge: ${JSON.stringify(at)}`);
  await shot(host, "130-presence-marker-left");

  // Ada moves her mouse off the board: her marker points at the middle of her view.
  await guest.mouse.move(700, 20);
  await settle();
  at = await marker(host, "Ada");
  check(!!at && at.x < 40, `with her mouse off the board, the marker stays: ${JSON.stringify(at)}`);

  // Ada pans down a long way: her marker moves to the bottom edge.
  await guest.mouse.move(700, 450);
  for (let i = 0; i < 20; i++) await guest.mouse.wheel(0, 400);
  await guest.mouse.move(700, 20);
  await settle();
  at = await marker(host, "Ada");
  check(!!at && at.y > at.h - 80, `after she pans down, it is on the bottom edge: ${JSON.stringify(at)}`);
  await shot(host, "131-presence-marker-bottom");

  // Ada pans with her mouse still on the board: her pointer moves over the board with it.
  await guest.mouse.move(700, 450);
  await settle();
  const pointer = () =>
    host.evaluate(() => {
      const room = (window as any).room;
      const ada = [...room.awareness.getStates().values()].find((s: any) => s.user?.name === "Ada");
      return ada?.pointer as { x: number; y: number } | null;
    });
  const before = await pointer();
  for (let i = 0; i < 3; i++) await guest.mouse.wheel(0, 200);
  await settle();
  const after = await pointer();
  check(
    !!before && !!after && Math.round(after.y - before.y) === 600,
    `her pointer moves 600 px with the board: ${JSON.stringify({ before, after })}`,
  );
  await guest.mouse.move(700, 20);
  await settle();

  // Karl clicks it: he goes there, and it is gone.
  await host.locator('[data-peer-marker="Ada"]').click();
  await settle();
  check((await marker(host, "Ada")) === null, "Karl clicks the marker: Ada is in view, no marker");

  // Following Ada's view, as in Miro.
  type View = { x: number; y: number; w: number; h: number };
  const view = (page: Page) =>
    page.evaluate(() => (window as any).room.awareness.getLocalState().view as View);
  const centre = (v: View) => ({ x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2) });
  const same = (a: View, b: View) =>
    Math.abs(centre(a).x - centre(b).x) <= 2 &&
    Math.abs(centre(a).y - centre(b).y) <= 2 &&
    Math.abs(a.w - b.w) <= 2;
  /** Her view fits in his, centred (screens may differ in size). */
  const fits = (karl: View, ada: View) =>
    Math.abs(centre(karl).x - centre(ada).x) <= 2 &&
    Math.abs(centre(karl).y - centre(ada).y) <= 2 &&
    karl.w >= ada.w - 1 &&
    karl.h >= ada.h - 1;
  const following = () =>
    host.evaluate(() => document.querySelector("[data-following-view]")?.getAttribute("data-following-view") ?? null);
  const avatar = host.locator('header [data-avatar="Ada"]');
  const board = guest.locator("[data-board]");

  await host.mouse.move(700, 450);
  for (let i = 0; i < 5; i++) await host.mouse.wheel(0, -500);
  await avatar.click();
  await settle();
  check((await following()) === "Ada", "Karl clicks Ada's avatar: his board is framed, following Ada");
  check(same(await view(host), await view(guest)), "he sees what she sees");

  // Ada pans and zooms: Karl's view goes with hers.
  await board.hover({ position: { x: 700, y: 450 } });
  for (let i = 0; i < 8; i++) await guest.mouse.wheel(250, 150);
  await guest.getByTitle("Zoom in").click();
  await guest.getByTitle("Zoom in").click();
  await settle();
  let [karl, ada] = [await view(host), await view(guest)];
  check(same(karl, ada), `Ada pans and zooms, Karl goes with her: ${JSON.stringify({ karl, ada })}`);
  await shot(host, "132-presence-following");
  await shot(guest, "132-presence-followed");

  // A smaller screen: Karl still sees all of what she sees, around the same middle.
  await guest.setViewportSize({ width: 900, height: 700 });
  await guest.mouse.move(450, 300);
  await guest.mouse.wheel(10, 0);
  await settle();
  [karl, ada] = [await view(host), await view(guest)];
  check(
    fits(karl, ada),
    `on a smaller screen, her view fits in his, centred: ${JSON.stringify({ karl, ada })}`,
  );

  // Karl pans himself: he lets go, and stays where he is.
  await host.mouse.move(700, 450);
  await host.mouse.wheel(0, 300);
  await settle();
  check((await following()) === null, "Karl pans: no longer following");
  karl = await view(host);
  for (let i = 0; i < 4; i++) await guest.mouse.wheel(300, 0);
  await settle();
  check(same(karl, await view(host)), "Ada pans again: Karl's view stays");
  await shot(host, "133-presence-let-go");

  // Again, then Stop; and clicking the avatar of whom he follows lets go too.
  await avatar.click();
  await settle();
  check(fits(await view(host), await view(guest)) && (await following()) === "Ada", "he follows again");
  await host.getByRole("button", { name: "Stop", exact: true }).click();
  check((await following()) === null, "Stop lets go");
  await avatar.click();
  await avatar.click();
  check((await following()) === null, "the avatar again lets go");

  // Ada zooms with the buttons while Karl follows; then Karl zooms: he lets go.
  await avatar.click();
  await host.getByTitle("Zoom out").click();
  check((await following()) === null, "Karl's zoom buttons let go");
  await avatar.click();
  await settle();
  await host.mouse.move(700, 450);
  await host.mouse.down({ button: "middle" });
  await host.mouse.move(800, 500, { steps: 5 });
  await host.mouse.up({ button: "middle" });
  check((await following()) === null, "a middle-button drag lets go");

  // Ada leaves: Karl stops following her.
  await avatar.click();
  await settle();
  await guest.close();
  await host.locator('header [data-avatar="Ada"]').waitFor({ state: "detached", timeout: 30000 });
  check((await following()) === null, "Ada leaves: Karl no longer follows");
}
if (step === "fullscreen") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  // A row of three, a terminal last, and a frame in the row under it.
  const files = (await (await addFrame(host, "Files")).getAttribute("data-frame"))!;
  const draw = (await (await addFrame(host, "Drawing")).getAttribute("data-frame"))!;
  const term = (await (await addFrame(host, "Terminal")).getAttribute("data-frame"))!;
  const web = (await (await addFrame(host, "Browser")).getAttribute("data-frame"))!;
  await place(host, files, { x: 0, y: 0, w: 600, h: 400 });
  await place(host, draw, { x: 624, y: 0, w: 600, h: 400 });
  await place(host, term, { x: 1248, y: 0, w: 560, h: 380 });
  await place(host, web, { x: 0, y: 424, w: 600, h: 400 });
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle(800);

  const frame = (id: string, page = host) => page.locator(`[data-frame="${id}"]`);
  const mode = (id: string, page = host) => frame(id, page).getAttribute("data-fullscreen");
  const current = () =>
    host.locator("[data-fullscreen-dot][aria-current]").getAttribute("data-fullscreen-dot");
  const docH = (id: string) =>
    host.evaluate((f) => (window as any).room.doc.getMap("frames").get(f).get("h"), id);
  const transform = () =>
    host.evaluate(
      () => (document.querySelector("[data-board] > div") as HTMLElement).style.transform,
    );
  const board = (await host.locator("[data-board]").boundingBox())!;
  const on = async () => (await host.locator("[data-fullscreen-bar]").count()) > 0;

  // F over a frame: 100%, its top under the top bar, as tall as the screen.
  const b = (await frame(files).boundingBox())!;
  await host.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await host.keyboard.press("f");
  await settle();
  let box = (await frame(files).boundingBox())!;
  check((await transform()).includes("scale(1)"), `F: at 100% (${await transform()})`);
  check(Math.abs(box.y - board.y) < 1, `…the frame's top under the top bar (${box.y})`);
  check(Math.abs(box.height - board.height) < 1, `…as tall as the screen (${box.height})`);
  check(Math.abs(box.x + box.width / 2 - board.width / 2) < 1, "…in the middle");
  check((await mode(draw)) === "in" && (await mode(term)) === "in", "…with its row");
  check((await mode(web)) === "hidden", "…and the row under it hidden");
  const termBox = (await frame(term).boundingBox())!;
  check(Math.abs(termBox.height - 380) < 1, `a terminal keeps its height (${termBox.height})`);
  check((await docH(files)) === 400, "the doc keeps the frame's height");
  check(
    (await host.locator("[data-hud]").getByTitle("Zoom in").count()) === 0 ||
      !(await host.locator("[data-hud]").getByTitle("Zoom in").isVisible()),
    "no zoom controls",
  );
  check(
    !(await host.locator("[data-hud]").getByRole("button", { name: "Agent" }).isVisible()),
    "no frame toolbar",
  );
  await settle(600);
  check((await mode(files, guest)) === null, "the guest's board isn't full screen");
  const guestFiles = (await frame(files, guest).boundingBox())!;
  const guestWeb = (await frame(web, guest).boundingBox())!;
  check(Math.abs(guestFiles.height / guestWeb.height - 1) < 0.01, "…its frames keep their heights");
  check((await frame(files, guest).getAttribute("data-occupant")) === "Karl", "Karl occupies it");
  await shot(host, "140-fullscreen");

  // Along the row: l, Alt + →, h. Each claims the frame it goes to.
  await host.mouse.move(board.x + board.width / 2, 20);
  await host.keyboard.press("l");
  await settle();
  check((await current()) === draw, "l goes to the next frame");
  box = (await frame(draw).boundingBox())!;
  check(Math.abs(box.x + box.width / 2 - board.width / 2) < 1, "…and shows it in the middle");
  const url = host.url();
  await host.keyboard.press("Alt+ArrowRight");
  await settle();
  check((await current()) === term, "Alt + → goes to the next");
  check(host.url() === url, "…and not Back or Forward");
  await host.keyboard.press("l");
  await settle();
  check((await current()) === term, "l at the end stays");
  await host.keyboard.press("h");
  await host.keyboard.press("Alt+ArrowLeft");
  await settle();
  check((await current()) === files, "h and Alt + ← go back");
  await settle(300);
  check((await frame(files, guest).getAttribute("data-occupant")) === "Karl", "…claiming it");

  // Typing is the field's: "f" in the frame's title stays there.
  const title = frame(files).getByLabel("Frame title");
  await title.click();
  await host.keyboard.press("End");
  await host.keyboard.type("f");
  check(await on(), "typing f into a title stays full screen");
  await host.keyboard.press("Backspace");
  await host.mouse.click(board.x + board.width / 2, 20);

  // Dragging a header only reorders the row: past the drawing's middle, it swaps with it.
  const at = (id: string) =>
    host.evaluate((f) => (window as any).room.doc.getMap("frames").get(f).toJSON(), id);
  const header = (await frame(files).locator("input[aria-label='Frame title']").boundingBox())!;
  await host.mouse.move(header.x + header.width + 60, header.y + 5);
  await host.mouse.down();
  await host.mouse.move(header.x + header.width + 760, header.y + 105, { steps: 8 });
  check(
    (await host.locator("[data-snap-preview]").count()) === 1,
    "dragging along the row shows where it goes",
  );
  await host.mouse.up();
  await settle();
  const [moved, swapped] = [await at(files), await at(draw)];
  check(
    moved.x === 624 && moved.y === 0 && swapped.x === 0 && swapped.y === 0,
    `…and drops it into the row, not up or down (${moved.x},${moved.y} / ${swapped.x})`,
  );
  check(await on(), "…still full screen");
  check((await current()) === files, "…the view going after it");
  const dots = await host
    .locator("[data-fullscreen-dot]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-fullscreen-dot")));
  check(dots[0] === draw && dots[1] === files, "…and the dots in its new order");

  // Held at the board's side, the drag scrolls the row: past the terminal, and back to the front.
  const order = () =>
    host
      .locator("[data-fullscreen-dot]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-fullscreen-dot")));
  const edgeDrag = async (clientX: number) => {
    const grip = (await frame(files).locator("input[aria-label='Frame title']").boundingBox())!;
    await host.mouse.move(grip.x + grip.width + 40, grip.y + 5);
    await host.mouse.down();
    await host.mouse.move(clientX, grip.y + 5, { steps: 8 });
    const from = await transform();
    await settle(2000);
    const held = await transform();
    await host.mouse.up();
    await settle();
    return { from, held };
  };
  let scrolled = await edgeDrag(board.x + board.width - 5);
  check(scrolled.held !== scrolled.from, `the right side scrolls the row (${scrolled.held})`);
  check(
    (await at(files)).x === 1208 && (await at(term)).x === 624 && (await at(files)).y === 0,
    `…the frame dropped past the terminal (${(await at(files)).x})`,
  );
  check(
    JSON.stringify(await order()) === JSON.stringify([draw, term, files]),
    "…last in the row",
  );
  check(await on(), "…still full screen");
  scrolled = await edgeDrag(board.x + 5);
  check(scrolled.held !== scrolled.from, `the left side scrolls it back (${scrolled.held})`);
  check(
    JSON.stringify(await order()) === JSON.stringify([files, draw, term]) &&
      (await at(files)).x === 0 &&
      (await at(term)).x === 1248,
    `…the frame first in the row (${(await at(files)).x})`,
  );
  check((await current()) === files, "…the view going after it");

  // "+" after the terminal adds a drawing there, and goes to it.
  await host.locator("[data-fullscreen-dot]").nth(2).click();
  await settle();
  const t = (await frame(term).boundingBox())!;
  await host.mouse.move(t.x + t.width / 2, t.y + 100);
  await host.locator("[data-fullscreen-insert=right]").click();
  await host.locator("[data-fullscreen-menu]").getByRole("button", { name: "Drawing" }).click();
  await settle();
  check((await host.locator("[data-fullscreen-dot]").count()) === 4, "+ adds a frame to the row");
  const added = (await current())!;
  const addedAt = await host.evaluate(
    (f) => (window as any).room.doc.getMap("frames").get(f).toJSON(),
    added,
  );
  check(
    addedAt.type === "drawing" && addedAt.x === 1248 + 560 + 24 && addedAt.y === 0,
    `…after the terminal, and goes there (${JSON.stringify(addedAt)})`,
  );
  await shot(host, "141-fullscreen-added");

  // The wheel pans along the row only.
  const before = await transform();
  await host.mouse.move(board.x + 4, board.y + board.height - 4);
  await host.mouse.wheel(0, 300);
  await settle(200);
  const after = await transform();
  const y = (s: string) => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(s)?.slice(1).map(Number);
  check(
    y(before)![1] === y(after)![1] && y(before)![0] !== y(after)![0],
    `the wheel pans along (${before} → ${after})`,
  );
  check(await on(), "…still full screen");

  // Zooming ends it; so do Esc, ✕ and following someone.
  await host.keyboard.down("Control");
  await host.mouse.wheel(0, 100);
  await host.keyboard.up("Control");
  await settle();
  check(!(await on()) && (await mode(files)) === null, "zooming ends it");
  check(await host.locator("[data-hud]").getByTitle("Zoom in").isVisible(), "…zoom controls back");
  const enter = async () => {
    await host.locator("[data-hud]").getByTitle("Fit board to view").click();
    await frame(files).locator("[data-fullscreen-toggle]").click();
    await settle();
    return on();
  };
  await host.locator("[data-hud]").getByTitle("Fit board to view").click();
  await settle();
  const fitted = await transform();
  check(await enter(), "the header's button goes full screen");
  await host.keyboard.press("Escape");
  await settle();
  check(!(await on()), "Esc ends it");
  check((await transform()) === fitted, `…back to the view before (${await transform()})`);
  await enter();
  await host.locator("[data-fullscreen-exit]").click();
  await settle();
  check(!(await on()), "✕ ends it");
  check((await transform()) === fitted, "…back to the view before too");
  await enter();
  await host.locator('header [data-avatar="Ada"]').click();
  await settle();
  check(!(await on()), "following Ada ends it");
  await host.locator('header [data-avatar="Ada"]').click();

  // Closing the frame goes on to the next of the row; the row's last frame ends it.
  await enter();
  await frame(files).getByTitle("Remove frame").click();
  await settle();
  check(await on(), "closing the frame stays full screen");
  check((await current()) === draw, "…on the next frame of the row");
  for (const id of [draw, term, added])
    await host.evaluate((f) => (window as any).room.doc.getMap("frames").delete(f), id);
  await settle();
  check(!(await on()), "removing the row's last frame ends it");
}
if (step === "needs-you") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  for (const page of [host, guest]) await page.locator("[data-hud]").getByTitle("Reset to 100%").click();

  // Reading outside the project makes opencode ask (its default policy).
  const frame = await newAgent(host, "opencode");
  const id = (await frame.getAttribute("data-frame"))!;
  await frame.locator(".cm-content").click();
  await host.keyboard.type("Read the file /etc/hostname with your read tool and tell me what it says.");
  await host.keyboard.press("Control+Enter");
  await host.locator(`[data-needs-host="${id}"]`).waitFor({ timeout: 120_000 });
  check(true, "the host's header says the agent needs them");
  check(
    (await host.locator(`[data-needs-host="${id}"]`).innerText()).includes("needs you"),
    "…in those words",
  );
  check((await frame.getAttribute("data-attention")) !== null, "the frame is outlined");
  await guest.locator(`[data-needs-host="${id}"]`).waitFor({ timeout: 10_000 });
  check(
    (await guest.locator(`[data-needs-host="${id}"]`).innerText()).includes("needs host"),
    "the guest's header says it needs the host",
  );
  check(
    (await host.locator("[data-waiting-count]").innerText()).includes("1 agent needs you"),
    "the host's top bar counts it",
  );
  check(
    (await guest.locator("[data-waiting-count]").innerText()).includes("waits for the host"),
    "the guest's top bar counts it, for the host",
  );
  check((await host.locator("[data-waiting-marker]").count()) === 0, "in view: no marker");
  await shot(host, "140-needs-you-host");
  await shot(guest, "140-needs-you-guest");

  // Pan far away: a marker points back to it; a click goes there.
  await host.mouse.move(60, 820);
  for (let i = 0; i < 10; i++) await host.mouse.wheel(400, 0);
  await settle();
  check((await host.locator(`[data-waiting-marker="${id}"]`).count()) === 1, "out of view: a marker");
  await shot(host, "141-needs-you-marker");
  await host.locator(`[data-waiting-marker="${id}"]`).click();
  await settle(900);
  check((await host.locator("[data-waiting-marker]").count()) === 0, "a click on it goes there");
  for (let i = 0; i < 10; i++) await host.mouse.wheel(0, 400);
  await settle();
  await host.locator("[data-waiting-count]").click();
  await settle(900);
  check((await host.locator("[data-waiting-marker]").count()) === 0, "so does the top bar's count");

  // Answering it ends all of it.
  await host.locator(`[data-frame="${id}"] [data-permission-kind=allow_once]`).first().click();
  await host.locator(`[data-needs-host="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
  check((await host.locator("[data-waiting-count]").count()) === 0, "answered: the count goes");
  check((await frame.getAttribute("data-attention")) === null, "…and the outline");
  await approveUntilIdle(host, guest);
}
await browser.close();
