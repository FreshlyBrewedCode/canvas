// Previews (ADR 0004, finding 09): an HTML file of the shared set renders for
// everyone in a sandbox; the host's loopback loads for the host only; nothing
// but http(s) loads.
import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { add, arrange, clear, frame } from "../board";
import { expect, test } from "../fixtures";

let local: Server;
let port: number;
test.beforeAll(async () => {
  // A dev server on the host's loopback.
  local = createServer((_, res) => res.end("<h1>local dev server</h1>"));
  await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
  port = (local.address() as AddressInfo).port;
});
test.afterAll(() => local.close());

test("previews: sandboxed HTML, the host's loopback, http(s) only", async ({
  host,
  guest,
  serve,
}) => {
  await clear(host);

  await test.step("an HTML file renders for everyone, its scripts sandboxed", async () => {
    const file = await add(host, "Files");
    await arrange(host, {
      [file]: { path: "page.html", title: "page.html", x: 0, y: 0, w: 640, h: 420 },
    });
    const doc = (p: Page) => frame(p, file).locator("iframe").contentFrame();
    for (const p of [host, guest]) {
      await expect(doc(p).locator("#probe")).toHaveText(
        "scripts run; storage blocked; parent blocked",
        { timeout: 10_000 },
      );
      await expect(frame(p, file).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    }
    const path = join(serve.dir, "page.html");
    writeFileSync(path, readFileSync(path, "utf8").replace("Hello preview", "Hello again"));
    await expect(doc(guest).getByText("Hello again"), "the preview follows the file").toBeVisible({
      timeout: 10_000,
    });
  });

  const web = await add(host, "Browser");
  const url = `http://127.0.0.1:${port}/`;
  const bar = (p: Page) => frame(p, web).locator("input[name=url]");

  await test.step("loopback: the host's frame loads it, a guest's says where it is", async () => {
    await arrange(host, { [web]: { url, title: "local", x: 700, y: 0, w: 640, h: 420 } });
    await expect(
      frame(host, web).locator("iframe").contentFrame().locator("body"),
      "the host loads its own localhost",
    ).toContainText("local dev server", { timeout: 10_000 });
    await expect(frame(guest, web).getByText("is on the host's machine")).toBeVisible({
      timeout: 10_000,
    });
    await expect(frame(guest, web).locator("iframe"), "no iframe for the guest").toHaveCount(0);
  });

  await test.step("a typed loopback address gets http, not https", async () => {
    await bar(guest).fill(`localhost:${port}`);
    await bar(guest).press("Enter");
    await expect(bar(host)).toHaveValue(`http://localhost:${port}`);
  });

  await test.step("anything but http(s), written straight into the board, loads nowhere", async () => {
    await guest.evaluate(
      ([id]) => (window as any).room.doc.getMap("frames").get(id).set("url", "javascript:alert(1)"),
      [web],
    );
    for (const p of [host, guest]) {
      await expect(frame(p, web).getByText("Only http and https URLs load.")).toBeVisible({
        timeout: 10_000,
      });
      await expect(frame(p, web).locator("iframe")).toHaveCount(0);
    }
  });
});
