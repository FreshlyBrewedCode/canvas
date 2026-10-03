// The connection dialog (finding 15): what host and guest see when it works,
// and the headline for each way it fails — WebRTC blocked (no ICE path), and
// the signalling relay blocked. Peers meet on the local relay and connect
// over WebRTC (`--relay-via signal`), as they do on Nostr.
import type { Page } from "@playwright/test";
import { E2E } from "../env";
import { expect, open, test } from "../fixtures";

test.use({ via: "signal" });

const dialog = async (page: Page) => {
  await page.locator("[data-connection-indicator]").click();
  return page.locator("[data-connection-dialog]");
};
const headline = (page: Page) => page.locator("[data-connection-headline]");

test("the connection dialog says how peers connect", async ({ host, guest, serve }) => {
  const secrets = new URLSearchParams(new URL(serve.link).hash.slice(1));
  for (const [name, page] of [
    ["host", host],
    ["guest", guest],
  ] as const)
    await test.step(name, async () => {
      const d = await dialog(page);
      await expect(headline(page)).toContainText("Connected to one peer", { timeout: 30_000 });
      // The route comes from WebRTC stats, read once a second while open.
      await expect(d.getByText(/direct|relayed/).first(), "the peer's route").toBeVisible();
      await expect(d.locator("[data-network-test]"), "the network test ran").toBeVisible({
        timeout: 10_000,
      });
      await d.getByText("Details").click();
      await expect(d.getByText("Peer connections")).toBeVisible();
      // The report is for sending around: it must not carry the link's secrets.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await d.getByRole("button", { name: "Copy report" }).click();
      const text = await page.evaluate(() => navigator.clipboard.readText());
      const report = JSON.parse(text) as { peers: unknown[]; log: unknown[] };
      expect(report.peers, "the report has the peer").toHaveLength(1);
      expect(report.log.length, "…and the log").toBeGreaterThan(0);
      for (const key of ["k", "pair", "pk"])
        if (secrets.get(key))
          expect(text, `the report has no ${key}`).not.toContain(secrets.get(key)!);
      await page.keyboard.press("Escape");
    });
});

test("WebRTC blocked: found peers, but couldn't connect", async ({
  browser,
  guestLink,
}, testInfo) => {
  // Only TURN candidates, and no TURN server — as on a network that blocks UDP.
  const page = await open(browser, guestLink, "Blocked", "#22c55e", testInfo, async (context) => {
    await context.addInitScript(() => {
      const Native = RTCPeerConnection;
      // @ts-expect-error replacing the constructor
      window.RTCPeerConnection = function (config?: RTCConfiguration) {
        return new Native({ ...config, iceServers: [], iceTransportPolicy: "relay" });
      };
      window.RTCPeerConnection.prototype = Native.prototype;
    });
  });
  await dialog(page);
  await expect(headline(page)).toContainText("Found peers, but couldn't connect to them", {
    timeout: 60_000,
  });
  await expect(
    page.locator("[data-connection-indicator]"),
    "the indicator turns red",
  ).toHaveAttribute("data-status", "blocked");
  await page.context().close();
});

test("signalling blocked: no relay reachable", async ({ browser, guestLink }, testInfo) => {
  const page = await open(browser, guestLink, "Offline", "#22c55e", testInfo, (context) =>
    context.routeWebSocket(
      (url: URL) => url.port === String(E2E.relayPort),
      (ws: { close(): Promise<void> }) => ws.close(),
    ),
  );
  await dialog(page);
  await expect(headline(page)).toContainText("No signalling relay reachable", { timeout: 20_000 });
  await page.context().close();
});
