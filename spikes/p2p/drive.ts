// Two independent browser contexts (separate storage, like two users) on the
// public https origin; report discovery time, yjs convergence, local reach.
import { chromium } from "playwright";
const room = "r" + Math.random().toString(36).slice(2, 8);
const url = `https://dev.example.ts.net:5199/?room=${room}&local=5198`;
const browser = await chromium.launch();
const pages = await Promise.all([0, 1].map(async () => (await browser.newContext()).newPage()));
for (const p of pages) p.on("pageerror", (e) => console.log("pageerror:", e.message));
for (const p of pages) p.on("console", (m) => m.type() === "error" && !m.text().includes("WebSocket connection") && console.log("console:", m.text()));
await Promise.all(pages.map((p) => p.goto(url)));
const t = Date.now();
while (Date.now() - t < 30000) {
  const done = await Promise.all(pages.map((p) => p.evaluate(() => (window as any).items?.().length === 2).catch(() => false)));
  if (done.every(Boolean)) break;
  await new Promise((r) => setTimeout(r, 250));
}
for (const p of pages) console.log(await p.evaluate(() => ({ ...(window as any).spike, items: (window as any).items() })));
await browser.close();
