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

const step = process.env.STEP ?? "basic";
if (step === "approve") await approveUntilIdle(host, guest);
if (step === "basic") {
  await host.getByRole("button", { name: "opencode" }).click();
  await host.locator("[data-frame-type=agent]").first().waitFor();
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
  await host.getByRole("button", { name: "Claude Code" }).click();
  const frame = host.locator("[data-frame-type=agent]").last();
  await frame.waitFor();
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
  // Put the markdown frame beside the agent, then the guest selects reply text.
  for (const page of [host]) {
    await page.evaluate(() => {
      const room = (window as any).room;
      room.doc.getMap("frames").forEach((map: any) => {
        if (map.get("type") === "markdown") map.set("x", 1000);
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
  // A markdown artifact bound to the file the agent wrote.
  await host.getByRole("button", { name: "Markdown" }).click();
  const md = host.locator("[data-frame-type=markdown]").last();
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
  await host.getByRole("button", { name: "Terminal" }).click();
  const term = host.locator("[data-frame-type=terminal]").last();
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
await browser.close();
