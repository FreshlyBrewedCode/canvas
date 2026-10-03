// A board on a `canvas relay` (ADR 0008, finding 16), for everything or only
// for peers to meet: a guest that can reach neither the Nostr relays nor (all
// through the relay) WebRTC joins, edits the board both ways and runs a
// request on the host; a token that doesn't verify is refused.
import type { Page } from "@playwright/test";
import { add, frame, settle } from "../board";
import { expect, letIn, open, test } from "../fixtures";
import { request, setTrusted } from "../members";

const headline = (page: Page) => page.locator("[data-connection-headline]");

for (const via of ["transport", "signal"] as const)
  test.describe(`through the relay (${via})`, () => {
    test.use({ via });

    test("a locked-down guest joins and works", async ({
      browser,
      host,
      guest,
      guestLink,
      serve,
    }, testInfo) => {
      await test.step("the host connects to the guest", async () => {
        await expect(guest.getByText("host online")).toBeVisible();
        const g = new URLSearchParams(new URL(guestLink).hash.slice(1));
        expect(g.get("via"), "the guest link names the relay").toBe(via);
        expect(g.get("rt"), "…with a guest token").toContain(".g.");
        expect(serve.link, "the host link has none").not.toContain("rt=");
        await host.locator("[data-connection-indicator]").click();
        await expect(headline(host)).toContainText("Connected to one peer", { timeout: 15_000 });
        const dialog = host.locator("[data-connection-dialog]");
        await expect(
          dialog
            .getByText(via === "transport" ? "through canvas relay" : /direct|relayed via TURN/)
            .first(),
        ).toBeVisible({ timeout: 10_000 });
        await host.keyboard.press("Escape");
      });

      // No Nostr relays, and, for the transport, no WebRTC at all.
      const locked = await open(
        browser,
        guestLink,
        "Locked",
        "#22c55e",
        testInfo,
        async (context) => {
          await context.routeWebSocket(/^wss:/, (ws) => ws.close());
          if (via === "transport")
            await context.addInitScript(() => {
              // @ts-expect-error replacing the constructor
              window.RTCPeerConnection = function () {
                throw new Error("WebRTC is blocked here");
              };
            });
        },
      );

      await test.step("a guest without Nostr reaches the host, edits go both ways", async () => {
        await expect(locked.getByText("host online")).toBeVisible({ timeout: 30_000 });
        await letIn(host, locked, "Locked");
        const fromHost = await add(host, "Files");
        await expect(frame(locked, fromHost)).toBeVisible({ timeout: 10_000 });
        const fromGuest = await add(locked, "Files");
        await expect(frame(host, fromGuest)).toBeVisible({ timeout: 10_000 });
      });

      await test.step("terminal output reaches it, its requests run on the host", async () => {
        const term = await add(host, "Terminal");
        await frame(locked, term).locator(".xterm").waitFor({ timeout: 10_000 });
        await settle(1500);
        await frame(host, term).locator(".xterm").click();
        await host.keyboard.type("echo relay-$((6*7))\n");
        await expect(frame(locked, term).getByText("relay-42").first()).toBeVisible({
          timeout: 15_000,
        });
        // One needing no approval: its answer comes back.
        expect(await request(locked, { t: "agent-cancel", sessionId: "none" })).toBe("ok");
        // Trusted, it types into the terminal: the input runs on the host.
        await setTrusted(host, locked, true);
        await frame(locked, term).locator(".xterm").click();
        await locked.keyboard.type("echo trusted-$((6*7))\n");
        await expect(frame(host, term).getByText("trusted-42").first()).toBeVisible({
          timeout: 15_000,
        });
        await expect(frame(locked, term).getByText("trusted-42").first()).toBeVisible({
          timeout: 15_000,
        });
      });
      await locked.context().close();

      await test.step("a token that doesn't verify is refused", async () => {
        const forged = guestLink.replace(
          /rt=([^&]+)/,
          (_, t: string) => `rt=${t.slice(0, -4)}AAAA`,
        );
        const stranger = await open(browser, forged, "Stranger", "#a855f7", testInfo);
        await stranger.locator("[data-connection-indicator]").click();
        await expect(headline(stranger)).toContainText(
          via === "transport" ? "Can't reach the relay" : "No signalling relay reachable",
          { timeout: 20_000 },
        );
        await stranger.context().close();
      });
    });
  });
