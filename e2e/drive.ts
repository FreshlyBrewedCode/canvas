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
// their author or the host changes them. Against the project of finding 12.
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
await browser.close();
