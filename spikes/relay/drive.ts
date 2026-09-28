// Needs (not in package.json): bun add @trystero-p2p/ws-relay@0.25.4 turn-server@0.6.6
// Run relay.ts, and turn.ts / turn-node.mjs / coturn for mode=turn (TURN=host:port, TRANSPORT=udp).
// bun spikes/relay/drive.ts  (relay.ts running) — two contexts, one per mode.
import { chromium } from "playwright";
const base = "http://127.0.0.1:5210";
const browser = await chromium.launch();
// TURN REST credentials: username "<expiry>:<name>", credential base64(HMAC-SHA1(secret, username))
const turnHost = process.env.TURN ?? "192.168.1.55:3479";
const username = `${Math.floor(Date.now() / 1000) + 3600}:guest`;
const { createHmac } = await import("node:crypto");
const credential = createHmac("sha1", "spike-secret").update(username).digest("base64");
const turn = JSON.stringify({ urls: `turn:${turnHost}${process.env.TRANSPORT === "udp" ? "" : "?transport=tcp"}`, username, credential });
const modes = (process.env.MODES ?? "direct,relay-only,turn").split(",");
for (const mode of modes) {
  const room = "r" + Math.random().toString(36).slice(2, 8);
  const url = `${base}/?room=${room}&relay=${encodeURIComponent("ws://127.0.0.1:5210/relay")}&mode=${mode}&turn=${encodeURIComponent(turn)}`;
  const pages = await Promise.all([0, 1].map(async () => (await browser.newContext()).newPage()));
  for (const p of pages) p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await Promise.all(pages.map((p) => p.goto(url)));
  const t = Date.now();
  while (Date.now() - t < 25000) {
    const s = await Promise.all(pages.map((p) => p.evaluate(() => (window as any).spike)));
    if (s.every((x) => x.got.length > 0 || x.errors.length > 0)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const s = await Promise.all(pages.map((p) => p.evaluate(() => (window as any).spike)));
  console.log(mode, JSON.stringify(s.map(({ peers, got, errors }) => ({ peers, got: got.length, errors })), null, 1));
  await Promise.all(pages.map((p) => p.context().close()));
}
console.log("relay saw", JSON.stringify(await (await fetch(`${base}/seen`)).json(), null, 1));
await browser.close();
