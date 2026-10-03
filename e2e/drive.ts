// Exploratory multi-user drive: a host and a guest in separate browser
// contexts against the running dev server + `canvas serve`. Screenshots land
// in $OUT (default /tmp/canvas-shots).
//
// The host is a browser paired with `canvas serve` (ADR 0011): its profile
// lives in $HOST_PROFILE (default /tmp/canvas-e2e-host), so the link with a
// pairing code `serve` prints pairs it once, and the link without the code
// works from then on. `pairing` starts from a fresh profile.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const hostLink = process.argv[2]!;
const out = process.env.OUT ?? "/tmp/canvas-shots";
const step = process.env.STEP ?? "basic";
const u = new URL(hostLink);
const f = new URLSearchParams(u.hash.slice(1));
let guestLink = "";

const browser = await chromium.launch();
const screen = { viewport: { width: 1400, height: 900 }, colorScheme: "dark" } as const;
const hostContext = await chromium.launchPersistentContext(
  step === "pairing"
    ? mkdtempSync(join(tmpdir(), "canvas-e2e-host-"))
    : (process.env.HOST_PROFILE ?? "/tmp/canvas-e2e-host"),
  screen,
);
/** `url` in a page of `context`: by default a browser of its own. */
const open = async (
  url: string,
  name: string,
  color: string,
  context: BrowserContext | null = null,
) => {
  context ??= await browser.newContext(screen);
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

const host = await open(hostLink, "Karl", "#f97316", hostContext);
await host
  .getByText("connected to canvas serve")
  .or(host.locator("[data-host-refused]"))
  .waitFor({ timeout: 15000 });
if (await host.locator("[data-host-refused]").isVisible())
  throw new Error(
    `${await host.locator("[data-host-refused]").innerText()}\n(this profile, ${process.env.HOST_PROFILE ?? "/tmp/canvas-e2e-host"}, needs a link with a fresh pairing code: canvas pair)`,
  );
// The guest link as a host shares it. On a relay (ADR 0008) it carries a
// guest token only `canvas serve` can sign.
await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await host.getByRole("button", { name: "Copy guest link" }).click();
guestLink = await host.evaluate(() => navigator.clipboard.readText());
const g = new URLSearchParams(new URL(guestLink).hash.slice(1));
const guest = await open(guestLink, "Ada", "#3b82f6");
await guest.getByText("host online").waitFor({ timeout: 30000 });
console.log("guest sees host");

/**
 * The guest link is an invite (ADR 0011): a browser the host doesn't know
 * knocks, and the host lets it in. A member's browser comes straight in.
 */
async function letIn(page: Page, name: string, role: "view" | "edit" = "edit") {
  const knock = host.locator(`[data-knock="${name}"]`).first();
  const board = page.locator("[data-board]");
  // Two pages: no locator waits for either.
  const end = Date.now() + 30000;
  while (!(await knock.isVisible()) && !(await board.isVisible()) && Date.now() < end)
    await page.waitForTimeout(250);
  if (await knock.isVisible())
    await knock.getByRole("button", { name: role === "edit" ? "Admit to edit" : "Admit to view" }).click();
  await board.waitFor({ timeout: 30000 });
}
/** The host sets what `page`'s browser (a member) may do, and waits until it knows. */
async function setRole(role: "view" | "edit", page: Page = guest) {
  const fingerprint = await page.locator("[data-fingerprint-self]").getAttribute("data-fingerprint-self");
  await host.locator("[data-members-button]").click();
  await host.locator(`[data-member][data-fingerprint="${fingerprint}"] select`).selectOption(role);
  await host.keyboard.press("Escape");
  await page.locator(`[data-access="${role}"]`).waitFor({ timeout: 10000 });
}
/** The host trusts `page`'s browser (a member) for this session, or takes it back (ADR 0011, decision 4). */
async function setTrusted(on: boolean, page: Page = guest) {
  const fingerprint = await page.locator("[data-fingerprint-self]").getAttribute("data-fingerprint-self");
  await host.locator("[data-members-button]").click();
  const row = host.locator(`[data-member][data-fingerprint="${fingerprint}"]`);
  const toggle = row.getByRole("button", { name: /^(Trust|Take trusted back)/ });
  const access = await row.locator("select").inputValue();
  if ((await toggle.getAttribute("aria-pressed")) !== String(on)) await toggle.click();
  await host.keyboard.press("Escape");
  await page.locator(`[data-access="${on ? "trusted" : access}"]`).waitFor({ timeout: 10000 });
}
/**
 * The guest link the host's board gives now: after a reset of the invite
 * link (ADR 0011, decision 6), not the one we started with.
 */
async function copyGuestLink() {
  await host.getByRole("button", { name: "Copy guest link" }).click();
  return host.evaluate(() => navigator.clipboard.readText());
}
if (step !== "lobby") {
  await letIn(guest, "Ada");
  console.log("guest let in");
}

/** The host answers every tool permission the agent asks for until it goes idle. */
/** Until the agent is idle: `id`'s frame, else the last agent frame. */
async function approveUntilIdle(host: Page, guest: Page, id?: string | null) {
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
      await (id ? host.locator(`[data-frame="${id}"]`) : host.locator("[data-frame-type=agent]").last())
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

if (step === "approve") await approveUntilIdle(host, guest);
if (step === "basic") {
  // Its own frame, by id: frames earlier steps left are on the board too.
  const id = await (await newAgent(host, "opencode")).getAttribute("data-frame");
  const agent = (page: Page) => page.locator(`[data-frame="${id}"]`);
  await agent(guest).waitFor({ timeout: 10000 });
  console.log("guest sees agent frame");
  // Both write into the same prompt draft.
  await agent(guest).locator(".cm-content").click();
  await guest.keyboard.type("Create docs/plan.md with a 3-step plan for a todo app. ");
  await agent(host).locator(".cm-content").click();
  await host.keyboard.press("End");
  await host.keyboard.type("Keep it short.");
  await host.mouse.move(700, 300);
  await guest.mouse.move(500, 500);
  await new Promise((r) => setTimeout(r, 800));
  console.log(
    "draft:",
    await agent(guest).locator(".cm-content").innerText(),
  );
  await shot(host, "01-host-draft");
  await shot(guest, "01-guest-draft");
  // Guest sends → host must approve (default access: edit).
  await guest.keyboard.press("Control+Enter");
  await host.getByRole("button", { name: "Run on my machine" }).waitFor({ timeout: 10000 });
  await shot(host, "02-host-approval");
  await host.getByRole("button", { name: "Run on my machine" }).click();
  await agent(guest)
    .locator("[data-sel-key$=':prompt']")
    .first()
    .waitFor({ timeout: 10000 });
  await approveUntilIdle(host, guest, id);
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

/** The board's frames as the host's doc has them, with their rects (derived: ADR 0010). */
const framesOf = (page: Page): Promise<Array<Record<string, any>>> =>
  page.evaluate(() => (window as any).frames());
const brief = (f: Record<string, any>) =>
  `${f.id} ${f.type} "${f.title}" ${f.path ?? f.url ?? f.agent ?? ""}` +
  `${f.lines ? ` L${f.lines.start}-${f.lines.end}` : ""} @${f.x},${f.y} ${f.w}x${f.h}` +
  `${f.origin ? ` origin=${f.origin}` : ""}`;

/**
 * Change a frame's fields, as its own change. With x and y it leaves its place
 * in the tree and the host reads it back in by position, as it migrates boards
 * from before the tree (ADR 0010): `arrange` does that for several at once, so
 * they are read as one board.
 */
const place = (page: Page, id: string, patch: Record<string, unknown>) =>
  arrange(page, { [id]: patch });
const arrange = async (page: Page, patches: Record<string, Record<string, unknown>>) => {
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
  await new Promise((r) => setTimeout(r, 500));
};

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
  const readme = frames.find((f) => f.id === otherId);
  console.log(
    `opened by the agent: ${opened.length}; README alone in its cluster:`,
    frames.filter((f) => f.cluster === readme?.cluster).length === 1,
  );
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
  await setRole("view");
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
  await setRole("edit");
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
if (step === "plan") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  // AGENT=claude for Claude Code's todo list; opencode has one too.
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  const id = (await frame.getAttribute("data-frame"))!;
  await frame.locator(".cm-content").click();
  await host.keyboard.type(
    "Use your todo list tool to plan three steps: 'look around', 'think', 'answer'. " +
      "Then mark them in progress and completed one by one, updating the todo list each time, " +
      "and reply with just 'done'. Do nothing else.",
  );
  await host.keyboard.press("Control+Enter");
  const plan = (page: Page) => page.locator(`[data-frame="${id}"] [data-plan]`);
  await plan(host).waitFor({ timeout: 120_000 });
  check(true, "the plan shows above the composer");
  await shot(host, "150-plan-running");
  await approveUntilIdle(host, guest);
  const statuses = await plan(host)
    .locator("[data-plan-status]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-plan-status")));
  check(statuses.length === 3, `three steps: ${statuses.join(", ")}`);
  check(statuses.every((s) => s === "completed"), "all done once the turn ends");
  check((await plan(guest).locator("[data-plan-status]").count()) === 3, "the guest sees it too");
  await plan(guest).getByRole("button").first().click();
  check(
    (await plan(guest).locator("[data-plan-status]").count()) === 0 &&
      (await plan(host).locator("[data-plan-status]").count()) === 3,
    "folding it is the guest's own",
  );
  await shot(host, "151-plan-done");
  await shot(guest, "151-plan-folded-guest");
}
if (step === "thread-nav") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  const id = (await frame.getAttribute("data-frame"))!;
  const prompt = async (text: string) => {
    await frame.locator(".cm-content").click();
    await host.keyboard.type(text);
    await host.keyboard.press("Control+Enter");
    await approveUntilIdle(host, guest);
  };
  await prompt(
    "Read README.md, then math.ts, with your read tool, in two separate calls. " +
      "Then reply with a numbered list of 40 fruits, one per line.",
  );
  const body = host.locator(`[data-frame="${id}"] [data-frame-body]`);
  const latest = host.locator(`[data-frame="${id}"] [data-to-latest]`);
  // Before the fold's click below, which scrolls.
  check((await latest.count()) === 0, "at the end: no jump button");
  const steps = host.locator(`[data-frame="${id}"] [data-steps]`);
  // Tool calls left unfolded with nothing but reasoning between them: folding is broken.
  const unfolded = await host.evaluate((id) => {
    const rows = document.querySelectorAll(`[data-frame="${id}"] [data-row]`);
    const turns = new Set([...rows].filter((el) => !el.closest("[data-steps]")).map((el) => el.parentElement!));
    let most = 0;
    for (const turn of turns) {
      let run = 0;
      for (const child of turn.children) {
        const kind = child.getAttribute("data-row");
        if (kind === "tool") most = Math.max(most, ++run);
        else if (kind !== "thinking") run = 0;
      }
    }
    return most;
  }, id);
  check(unfolded < 2, `no run of tool calls left unfolded (${unfolded})`);
  if ((await steps.count()) === 0) {
    // The model decides: it may write between its calls, and then there is nothing to fold.
    if (unfolded < 2) console.log("skip tool calls fold: the agent made no two in a row");
  } else {
    check(/\d+ tool calls/.test(await steps.first().innerText()), `tool calls in a row fold, saying how many: ${await steps.first().innerText()}`);
    await shot(host, "160-steps-folded");
    // Playwright scrolls it into view to click it.
    await steps.first().getByRole("button").first().click();
    check((await steps.first().getByRole("button").count()) >= 3, "a click unfolds them");
    await shot(host, "161-steps-open");
  }

  // Scrolled up: a way back; more arriving says so.
  await body.evaluate((el) => (el.scrollTop = 0));
  await settle();
  check((await latest.getAttribute("data-to-latest")) === "yes", "scrolled up: a jump button");
  await frame.locator(".cm-content").click();
  await host.keyboard.type("Now a numbered list of 30 vegetables, one per line.");
  await host.keyboard.press("Control+Enter");
  await host.locator(`[data-frame="${id}"] [data-to-latest=news]`).waitFor({ timeout: 60_000 });
  check(true, "news while scrolled up: it says so");
  const top = await body.evaluate((el) => el.scrollTop);
  check(top === 0, "…and we stay where we were");
  await shot(host, "162-new-activity");
  await approveUntilIdle(host, guest);
  await latest.click();
  await settle(1200);
  const gap = await body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  check(gap < 40, `a click goes to the end (${gap}px left)`);
  check((await latest.count()) === 0, "…and the button goes");
}
if (step === "mode") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  const id = (await frame.getAttribute("data-frame"))!;
  const chip = (page: Page) => page.locator(`[data-frame="${id}"] [data-mode-chip]`);
  const settled = async (page: Page, tone: string) => {
    await page.locator(`[data-frame="${id}"] [data-mode-chip][data-mode-tone="${tone}"]:not([disabled])`).waitFor({ timeout: 30_000 });
    return chip(page).getAttribute("data-mode-chip");
  };
  const first = await settled(host, "default");
  check(!!first, `the chip shows the default mode, quietly: ${first}`);
  await shot(host, "170-mode-default");
  await chip(host).click();
  const second = await host.waitForFunction(
    ([id, first]) => {
      const el = document.querySelector(`[data-frame="${id}"] [data-mode-chip]`);
      return el && !el.hasAttribute("disabled") && el.getAttribute("data-mode-chip") !== first
        ? el.getAttribute("data-mode-chip")
        : null;
    },
    [id, first],
    { timeout: 30_000 },
  ).then((h) => h.jsonValue());
  check(second !== first, `a click goes to the next mode: ${second}`);
  check((await chip(host).getAttribute("data-mode-tone")) !== "default", "…which stands out");
  await guest.locator(`[data-frame="${id}"] [data-mode-chip="${second}"]`).waitFor({ timeout: 10_000 });
  check(true, "the guest sees it");
  await shot(host, "171-mode-next");
  await shot(guest, "171-mode-next-guest");
  // Shift+Tab in the composer goes round, never to bypassing permissions.
  const seen = [first, second];
  await frame.locator(".cm-content").click();
  // A mode the agent refuses (Claude Code's Auto on Haiku) stays put once, then is passed over.
  for (let i = 0; i < 8; i++) {
    await host.keyboard.press("Shift+Tab");
    await new Promise((r) => setTimeout(r, 300));
    await host.locator(`[data-frame="${id}"] [data-mode-chip]:not([disabled])`).waitFor({ timeout: 30_000 });
    const now = await chip(host).getAttribute("data-mode-chip");
    if (now !== seen.at(-1)) seen.push(now);
    if (now === first) break;
  }
  check(seen.at(-1) === first, `Shift+Tab goes round: ${seen.join(" → ")}`);
  check(!seen.some((m) => /bypass/i.test(m ?? "")), "…passing over bypassing permissions");
}
if (step === "copy") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  const text =
    "Reply with the sentence 'Here it is.' and then a ts code block containing exactly: const x = 1;";
  await frame.locator(".cm-content").click();
  await host.keyboard.type(text);
  await host.keyboard.press("Control+Enter");
  await approveUntilIdle(host, guest);
  const clipboard = () => host.evaluate(() => navigator.clipboard.readText());
  // Hidden is transparent: Playwright counts that as visible.
  const shown = async (button: ReturnType<Page["locator"]>) => {
    await new Promise((r) => setTimeout(r, 250));
    return button.evaluate((el) => getComputedStyle(el).opacity === "1");
  };
  const copy = async (within: ReturnType<Page["locator"]>) => {
    await within.hover();
    const button = within.locator(":scope > [data-copy], :scope > div > [data-copy]");
    check(await shown(button), "the copy button shows on hover");
    await button.click();
    return clipboard();
  };

  const code = frame.locator(".group\\/code").first();
  check((await copy(code)).trim() === "const x = 1;", "a code block copies its code");
  await shot(host, "180-copy-code");
  const message = frame.locator(".group\\/copy:has(.prose-canvas)").last();
  const markdown = await copy(message);
  check(markdown.includes("```") && markdown.includes("Here it is."), "a message copies its markdown");
  const prompt = frame.locator(".group\\/copy:has([data-sel-key$=':prompt'])").first();
  check((await copy(prompt)) === text, "a prompt copies as it was sent");
  await host.mouse.move(5, 5);
  await new Promise((r) => setTimeout(r, 1600));
  const buttons = frame.locator("[data-copy]");
  let hidden = true;
  for (let i = 0; i < (await buttons.count()); i++) hidden &&= !(await shown(buttons.nth(i)));
  check(hidden, "no buttons without the hover");
}
if (step === "usage") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  check((await frame.locator("[data-usage-ring]").count()) === 0, "no usage yet: no ring");
  await frame.locator(".cm-content").click();
  await host.keyboard.type("Count slowly from 1 to 5 in words, one per line.");
  await host.keyboard.press("Control+Enter");
  const running = frame.locator("[data-turn-footer=running]");
  await running.waitFor({ timeout: 30_000 });
  const first = await running.innerText();
  await settle(2200);
  const later = await running.innerText().catch(() => "(ended)");
  check(first.startsWith("working"), `while it runs, the time goes: ${first} → ${later}`);
  await approveUntilIdle(host, guest);
  const done = frame.locator("[data-turn-footer=done]");
  await done.waitFor({ timeout: 10_000 });
  const footer = await done.innerText();
  check(/^\d+s · [\d.]+k? tokens$/.test(footer), `once done: time and tokens: ${footer}`);
  const ring = frame.locator("[data-usage-ring]");
  await ring.waitFor({ timeout: 10_000 });
  const share = await ring.getAttribute("data-usage-ring");
  console.log(`     context: ${share === "" ? "size unknown (gauge)" : `${share}% (ring)`}`);
  check(true, "a usage button left of Send");
  await ring.hover();
  const popover = host.locator("[data-usage-popover]");
  await popover.waitFor({ timeout: 5000 });
  check((await popover.innerText()).includes("tokens"), "hovering it shows the session's usage");
  console.log(`     ${(await popover.innerText()).replace(/\n/g, " | ")}`);
  await settle(400);
  await shot(host, "190-usage-popover");
  await host.mouse.move(700, 120);
  await settle();
  check((await popover.count()) === 0, "…until the mouse leaves");
  await ring.click();
  await host.mouse.move(700, 120);
  await settle();
  check((await popover.count()) === 1, "a click keeps it open");
  await ring.click();
  await settle();
  check((await popover.count()) === 0, "another closes it");
  const guestFooter = guest.locator(`[data-frame="${await frame.getAttribute("data-frame")}"] [data-turn-footer=done]`);
  check((await guestFooter.innerText()) === footer, "the guest sees the same footer");
}
if (step === "history") {
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  await host.evaluate(() => {
    const frames = (window as any).room.doc.getMap("frames");
    for (const id of [...frames.keys()]) frames.delete(id);
  });
  const frame = await newAgent(host, process.env.AGENT ?? "opencode");
  const id = (await frame.getAttribute("data-frame"))!;
  const editor = (page: Page) => page.locator(`[data-frame="${id}"] [data-composer] .cm-content`);
  const draft = () =>
    host.evaluate((id) => (window as any).room.doc.getText(`prompt:${id}`).toString(), id);
  for (const prompt of ["Reply with just: A", "Reply with just: B"]) {
    await editor(host).click();
    await host.keyboard.type(prompt);
    await host.keyboard.press("Control+Enter");
    await approveUntilIdle(host, guest);
  }
  await editor(host).click();
  const seen: string[] = [];
  for (const key of ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown"]) {
    await host.keyboard.press(key);
    seen.push(await draft());
  }
  check(
    JSON.stringify(seen) ===
      JSON.stringify(["Reply with just: B", "Reply with just: A", "Reply with just: A", "Reply with just: B", ""]),
    `↑ and ↓ go through our prompts: ${JSON.stringify(seen)}`,
  );

  // Not over someone's draft; not someone else's prompts.
  await editor(guest).click();
  await guest.keyboard.type("Ada writes");
  await new Promise((r) => setTimeout(r, 500));
  await editor(host).click();
  await host.keyboard.press("Control+Home");
  await host.keyboard.press("ArrowUp");
  check((await draft()) === "Ada writes", "↑ leaves a draft someone wrote alone");
  await guest.keyboard.press("Control+a");
  await guest.keyboard.press("Backspace");
  await new Promise((r) => setTimeout(r, 300));
  await guest.keyboard.press("ArrowUp");
  await new Promise((r) => setTimeout(r, 300));
  check((await draft()) === "", "the guest's ↑ has none of the host's prompts");

  // A prompt back into the draft, from the thread.
  const prompt = host.locator(`[data-frame="${id}"] .group\\/copy:has([data-sel-key$=':prompt'])`).first();
  await prompt.hover();
  await prompt.locator("[data-reuse]").click();
  check((await draft()) === "Reply with just: A", "the prompt's button puts it into the draft");
  check(
    await host.evaluate(() => !!document.activeElement?.closest("[data-composer]")),
    "…with the composer focused",
  );
  await prompt.hover();
  await prompt.locator("[data-reuse]").click();
  check(
    (await draft()) === "Reply with just: A\n\nReply with just: A",
    "into a draft with text, it goes after it",
  );
  await shot(host, "200-history-reuse");
}
await hostContext.close();
await browser.close();
