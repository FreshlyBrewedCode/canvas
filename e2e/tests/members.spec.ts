// Identity, admission and pairing (ADR 0011): each browser has a key; the
// host is a paired browser; the guest link is an invite — strangers knock in
// a lobby, members come straight in; the host trusts one for a session,
// removes one, and resets the invite link, moving the members to a new room.
import type { Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { add, frames, frame } from "../board";
import { expect, letIn, open, test } from "../fixtures";
import {
  copyGuestLink,
  fingerprint,
  memberRow,
  remove,
  request,
  setRole,
  setTrusted,
} from "../members";

const ROOT = resolve(import.meta.dirname, "../..");
const connected = (page: Page) => page.getByText("connected to canvas serve");
const refused = (page: Page) => page.locator("[data-host-refused]");
const roomOf = (page: Page) => page.evaluate(() => (window as any).room.link.roomId as string);
const hostOnline = (page: Page) => page.evaluate(() => (window as any).room.hostOnline as boolean);
/** Set a key in the doc from `page`; whether `other`'s doc has it within `ms`. */
const reaches = async (page: Page, other: Page, ms = 1500) => {
  const key = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  // A guest sends it even if it isn't let in: the host is what refuses it.
  await page.evaluate((k) => {
    const room = (window as any).room;
    const access = room.participant.access;
    if (!room.isHost) room.participant.access = "edit";
    room.doc.getMap("e2e").set(k, 1);
    room.participant.access = access;
  }, key);
  return other
    .waitForFunction((k) => (window as any).room.doc.getMap("e2e").has(k), key, { timeout: ms })
    .then(() => true)
    .catch(() => false);
};

test("each browser proves its key; everyone sees whose each peer is", async ({ host, guest }) => {
  /** The fingerprint `page` shows on `name`'s avatar once verified. */
  const seen = (page: Page, name: string) =>
    expect.poll(
      () => page.locator(`[data-avatar="${name}"]`).first().getAttribute("data-fingerprint"),
      { timeout: 15_000 },
    );
  const [karl, ada] = [await fingerprint(host), await fingerprint(guest)];
  expect(karl).toMatch(/^[0-9a-f]{32}$/);
  expect(ada).toMatch(/^[0-9a-f]{32}$/);
  expect(karl, "host and guest have different keys").not.toBe(ada);
  await seen(host, "Ada").toBe(ada);
  await seen(guest, "Karl").toBe(karl);
  await expect(host.locator("[data-fingerprint-self]")).toHaveText(
    `${karl.slice(0, 4)} ${karl.slice(4, 8)}`,
  );

  await test.step("reloads keep the key: the guest's, then the host's", async () => {
    await guest.reload();
    await expect(guest.locator("[data-board]")).toBeVisible({ timeout: 30_000 });
    expect(await fingerprint(guest)).toBe(ada);
    await seen(host, "Ada").toBe(ada);
    await seen(guest, "Karl").toBe(karl);
    await host.reload();
    await expect(connected(host)).toBeVisible({ timeout: 15_000 });
    expect(await fingerprint(host)).toBe(karl);
    await seen(host, "Ada").toBe(ada);
    await seen(guest, "Karl").toBe(karl);
  });
});

test("the host is the browser that paired", async ({ browser, host, serve }, testInfo) => {
  const strangers: Page[] = [];
  const stranger = async (url: string) => {
    const page = await open(browser, url, "Mallory", "#ef4444", testInfo);
    strangers.push(page);
    return page;
  };
  const link = new URL(serve.link);
  expect(new URLSearchParams(link.hash.slice(1)).has("pair"), "the link carries a code").toBe(true);

  await test.step("it pairs, and reloads without the code", async () => {
    expect(host.url(), "the address bar drops the used code").not.toContain("pair=");
    await host.reload();
    await expect(connected(host)).toBeVisible({ timeout: 15_000 });
  });

  await test.step("other browsers with the link are refused", async () => {
    const withCode = await stranger(serve.link);
    await expect(refused(withCode), "the code is used up").toContainText("used up", {
      timeout: 15_000,
    });
    await expect(withCode.getByText("not paired with canvas serve")).toBeVisible();
    const fragment = new URLSearchParams(link.hash.slice(1));
    fragment.delete("pair");
    const noCode = await stranger(`${link.origin}${link.pathname}${link.search}#${fragment}`);
    await expect(refused(noCode), "and one without a code").toContainText("isn't paired", {
      timeout: 15_000,
    });
    await expect(connected(host), "neither unseats the host").toBeVisible();
  });

  await test.step("canvas pair pairs another browser while serve runs", async () => {
    const run = spawnSync("bun", ["src/cli.ts", "pair", "--dir", serve.dir], { cwd: ROOT });
    const printed = run.stdout.toString().match(/https?:\/\/\S+/)?.[0] ?? "";
    expect(printed, "a link with a fresh code").toContain("pair=");
    const device = await stranger(printed);
    await expect(connected(device), "a second browser pairs").toBeVisible({ timeout: 15_000 });
    await expect(host.locator("[data-host-elsewhere]"), "and becomes the host tab").toBeVisible({
      timeout: 10_000,
    });
    const late = await stranger(printed);
    await expect(refused(late), "its code is used up for a third").toBeVisible({ timeout: 15_000 });
  });
  for (const page of strangers) await page.context().close();
});

test("the guest link is an invite: the lobby", async ({ browser, host, guestLink }, testInfo) => {
  const guest = await open(browser, guestLink, "Ada", "#3b82f6", testInfo);
  const lobby = (state: string) => guest.locator(`[data-lobby="${state}"]`);
  const knock = host.locator('[data-knock="Ada"]').first();
  const ada = await fingerprint(guest);
  const ask = () => request(guest, { t: "agent-cancel", sessionId: "none" });

  await test.step("a stranger waits, with nothing of the board", async () => {
    await expect(lobby("lobby")).toBeVisible({ timeout: 30_000 });
    await expect(guest.locator("[data-board]")).toHaveCount(0);
    if ((await frames(host)).length === 0) await add(host, "Files");
    expect(
      await guest.evaluate(() => (window as any).frames().length),
      "its doc has no frames",
    ).toBe(0);
    expect(await reaches(host, guest), "the host's edits don't reach it").toBe(false);
    expect(await reaches(guest, host), "its edits don't reach the host").toBe(false);
    expect(await ask(), "its requests are refused").toContain("let you in");
    await expect(host.locator('[data-avatar="Ada"]'), "not shown as present").toHaveCount(0);
    await expect(knock).toBeVisible({ timeout: 10_000 });
    await expect(knock, "it knocks, by its full fingerprint").toHaveAttribute(
      "data-fingerprint",
      ada,
    );
    await expect(knock).toContainText(ada.match(/.{4}/g)!.join(" "));
  });

  await test.step("admitted to edit", async () => {
    await knock.getByRole("button", { name: "Admit to edit" }).click();
    await expect(guest.locator("[data-board]")).toBeVisible({ timeout: 15_000 });
    await guest.waitForFunction(() => (window as any).frames().length > 0, null, {
      timeout: 10_000,
    });
    await expect(guest.locator('[data-access="edit"]')).toHaveCount(1);
    expect(await reaches(guest, host, 10_000), "its edits reach the host").toBe(true);
    expect(await ask(), "its requests run").toBe("ok");
    await expect(host.locator('[data-avatar="Ada"]')).toBeVisible({ timeout: 10_000 });
    await host.locator("[data-members-button]").click();
    await expect((await memberRow(host, guest)).locator("select")).toHaveValue("edit");
    await host.keyboard.press("Escape");
  });

  await test.step("removed: cut off at once, and the invite link is reset", async () => {
    const first = await roomOf(host);
    await remove(host, guest);
    await expect(lobby("removed")).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('[data-avatar="Ada"]')).toHaveCount(0, { timeout: 10_000 });
    expect(await reaches(host, guest), "the host's edits no longer reach it").toBe(false);
    await expect.poll(() => roomOf(host)).not.toBe(first);
  });

  await test.step("with the new link it knocks again; denied, it is told so", async () => {
    await guest.goto(await copyGuestLink(host));
    await expect(lobby("lobby")).toBeVisible({ timeout: 30_000 });
    await expect(knock).toBeVisible({ timeout: 10_000 });
    await knock.getByRole("button", { name: "Deny" }).click();
    await expect(lobby("denied")).toBeVisible({ timeout: 10_000 });
    await expect(knock).toHaveCount(0);
  });

  await test.step("admitted to view; made edit; a member comes back without knocking", async () => {
    await guest.reload();
    await letIn(host, guest, "Ada", "view");
    await expect(guest.locator('[data-access="view"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(guest.locator("[data-hud]").getByRole("button", { name: "Agent" })).toHaveCount(0);
    expect(await reaches(guest, host), "a view guest's edits don't reach the host").toBe(false);
    expect(await ask(), "a view guest's requests are refused").toContain("read-only");
    await setRole(host, guest, "edit");
    expect(await reaches(guest, host, 10_000), "made edit, its edits reach the host").toBe(true);
    await guest.reload();
    await expect(guest.locator('[data-access="edit"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(knock, "no knock").toHaveCount(0);
  });
  await guest.context().close();
});

test("trusted for one host session", async ({ host, guest }) => {
  const approval = host.getByRole("button", { name: "Run on my machine" });
  /** A request that waits for the host's approval as edit: setting an agent's option. */
  const ask = () =>
    guest.evaluate(() => {
      (window as any).asked = (window as any).room
        .act({ t: "agent-config", sessionId: "none", configId: "model", value: "x" })
        .then(
          () => "ok",
          (e: Error) => e.message,
        );
    });
  const answer = () => guest.evaluate(() => (window as any).asked as Promise<string>);
  const term = await add(host, "Terminal");
  await frame(guest, term).locator(".xterm").waitFor({ timeout: 10_000 });
  await guest.waitForTimeout(1500);
  /** Whether what the guest types into the terminal runs on the host. */
  const typed = async (text: string) => {
    await frame(guest, term).locator(".xterm").click();
    await guest.keyboard.type(`echo ${text}-$((6*7))\n`);
    return frame(host, term)
      .getByText(`${text}-42`)
      .first()
      .waitFor({ timeout: 8000 })
      .then(
        () => true,
        () => false,
      );
  };

  await test.step("granted on top of the saved role", async () => {
    await expect(guest.locator('[data-access="edit"]')).toHaveCount(1);
    await setTrusted(host, guest, true);
    await host.locator("[data-members-button]").click();
    const row = await memberRow(host, guest);
    await expect(row).toHaveAttribute("data-trusted", "true");
    await expect(row.locator("select"), "its saved role stays edit").toHaveValue("edit");
    await host.keyboard.press("Escape");
    await ask();
    expect(await answer(), "its request runs without the approval click").toBe("ok");
    await expect(approval).toHaveCount(0);
    expect(await typed("trusted"), "it types into a terminal").toBe(true);
  });

  await test.step("a guest reload keeps it; taken back, it is edit again", async () => {
    await guest.reload();
    await expect(guest.locator('[data-access="trusted"]')).toHaveCount(1, { timeout: 30_000 });
    await setTrusted(host, guest, false);
    expect(await typed("untrusted"), "its typing no longer reaches the terminal").toBe(false);
    await setTrusted(host, guest, true);
  });

  await test.step("a host reload drops it: never saved", async () => {
    await host.reload();
    await expect(connected(host)).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('[data-access="edit"]')).toHaveCount(1, { timeout: 30_000 });
    await host.locator("[data-members-button]").click();
    await expect(await memberRow(host, guest)).not.toHaveAttribute("data-trusted", /.*/);
    await host.keyboard.press("Escape");
    await ask();
    await expect(approval, "its next request needs the host's approval").toBeVisible({
      timeout: 10_000,
    });
    await host.getByRole("button", { name: "Decline" }).click();
    expect(await answer()).toContain("declined");
    expect(await typed("reloaded"), "nor does its typing reach the terminal").toBe(false);
  });
});

test("presence only among members", async ({ browser, host, guest, guestLink }, testInfo) => {
  /** Whose presence `page` holds: name, pointer, the fingerprint shown. */
  type Peer = {
    name: string;
    pointer: { x: number; y: number } | null;
    fingerprint: string | null;
  };
  const others = (page: Page): Promise<Peer[]> =>
    page.evaluate(() =>
      ((window as any).room?.peerList ?? []).map((p: any) => ({
        name: p.user.name as string,
        pointer: p.pointer as { x: number; y: number } | null,
        fingerprint: p.fingerprint as string | null,
      })),
    );
  const has = async (page: Page, name: string) => (await others(page)).some((p) => p.name === name);
  /** Until `page` has `name`'s pointer at `x`; false if it never does. */
  const pointerAt = (page: Page, name: string, x: number, timeout = 15_000) =>
    page
      .waitForFunction(
        ([name, x]) =>
          (window as any).room.peerList.some(
            (p: any) => p.user.name === name && p.pointer?.x === x,
          ),
        [name, x] as const,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
  const point = (page: Page, x: number) =>
    page.evaluate((x) => (window as any).room.setPresence({ pointer: { x, y: 100 } }), x);
  /** `page` sends its presence to everyone in the room, past any filter: a tampered client. */
  const push = (page: Page) =>
    page.evaluate(() => {
      const room = (window as any).room;
      room.participant.sendPresence(room.peerIds());
    });
  const gone = (page: Page, name: string) =>
    expect.poll(() => has(page, name), { timeout: 5000 }).toBe(false);

  const bob = await open(browser, guestLink, "Bob", "#22c55e", testInfo);
  const knock = host.locator('[data-knock="Bob"]').first();

  await test.step("in the lobby, Bob gets nobody's presence, and gives none", async () => {
    await expect(bob.locator('[data-lobby="lobby"]')).toBeVisible({ timeout: 30_000 });
    await expect(knock).toBeVisible({ timeout: 10_000 });
    // What reaches Bob, on any channel: only the host's hello and admission.
    await bob.evaluate(() => {
      const room = (window as any).room;
      const got: string[] = ((window as any).received = []);
      for (const [name, channel] of Object.entries<any>(room.participant.actions)) {
        const handler = channel.onMessage;
        if (handler)
          channel.onMessage = (data: unknown, context: { peerId: string }) => {
            got.push(
              `${name} from ${context.peerId === room.participant.hostPeer ? "host" : context.peerId}`,
            );
            return handler(data, context);
          };
      }
    });
    await point(guest, 111);
    await point(host, 112);
    await bob.waitForTimeout(1500);
    expect(await others(bob)).toEqual([]);
    const received = await bob.evaluate(() => (window as any).received as string[]);
    for (const r of received) expect(["hello from host", "admission from host"]).toContain(r);
    await point(bob, 113);
    await push(bob);
    await bob.waitForTimeout(1500);
    expect(await has(guest, "Bob"), "Ada doesn't take Bob's, even sent to her").toBe(false);
    expect(await has(host, "Bob"), "nor does the host").toBe(false);
    expect(await has(guest, "Karl"), "Ada still has the host's").toBe(true);
  });

  const bobPrint = await fingerprint(bob);
  await test.step("let in, Bob and the members see each other", async () => {
    await knock.getByRole("button", { name: "Admit to edit" }).click();
    await expect(bob.locator("[data-board]")).toBeVisible({ timeout: 15_000 });
    await point(guest, 121);
    expect(await pointerAt(bob, "Ada", 121)).toBe(true);
    await point(bob, 122);
    expect(await pointerAt(guest, "Bob", 122)).toBe(true);
    expect(await pointerAt(host, "Bob", 122)).toBe(true);
    expect(
      (await others(guest)).find((p) => p.name === "Bob")?.fingerprint,
      "from the signed list",
    ).toBe(bobPrint);
    expect((await others(bob)).find((p) => p.name === "Ada")?.fingerprint).toBe(
      await fingerprint(guest),
    );
  });

  await test.step("removed, even a Bob who stays is dropped, and gets nothing", async () => {
    await bob.evaluate(() => {
      (window as any).room.participant.leaveRoom = () => {};
    });
    await remove(host, bob);
    await gone(guest, "Bob");
    await point(bob, 132);
    await push(bob);
    await point(guest, 131);
    await bob.waitForTimeout(1500);
    expect(await has(guest, "Bob"), "what Bob still sends, nobody takes").toBe(false);
    expect(await has(host, "Bob")).toBe(false);
    expect(await pointerAt(bob, "Ada", 131, 3000), "nor does Ada's pointer reach him").toBe(false);
    expect(await pointerAt(host, "Ada", 131), "Ada and the host still see each other").toBe(true);
  });

  await test.step("back with the new link, then removed as told: he holds nobody's", async () => {
    await bob.goto(await copyGuestLink(host));
    await letIn(host, bob, "Bob");
    await point(bob, 141);
    expect(await pointerAt(guest, "Bob", 141)).toBe(true);
    await remove(host, bob);
    await expect(bob.locator('[data-lobby="removed"]')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await others(bob)).length, { timeout: 5000 }).toBe(0);
    await gone(guest, "Bob");
  });
  await bob.context().close();
});

for (const via of ["transport", "signal"] as const)
  test.describe(`on the relay (${via})`, () => {
    test.use({ via });

    test("resetting the invite link moves the members to a new room", async ({
      browser,
      host,
      guest,
      guestLink,
      serve,
    }, testInfo) => {
      test.setTimeout(120_000);
      const urlRoom = (page: Page) => new URL(page.url()).searchParams.get("room");
      /** Until `page` is in the room the host is in now. */
      const followed = async (page: Page) => {
        const room = await roomOf(host);
        await page.waitForFunction(
          (r) => (window as any).room.link.roomId === r && (window as any).room.hostOnline,
          room,
          { timeout: 30_000 },
        );
      };
      const moved = (from: string) =>
        host.waitForFunction((r) => (window as any).room.link.roomId !== r, from, {
          timeout: 15_000,
        });

      // Ada (a member, trusted this session), Bob (a member), Cy (knocking).
      await setTrusted(host, guest, true);
      const bob = await open(browser, guestLink, "Bob", "#22c55e", testInfo);
      await letIn(host, bob, "Bob");
      const cy = await open(browser, guestLink, "Cy", "#a855f7", testInfo);
      await expect(host.locator('[data-knock="Cy"]').first()).toBeVisible({ timeout: 30_000 });
      const first = await roomOf(host);
      let newLink = "";

      await test.step("the members move along; the lobby stays behind", async () => {
        await host.locator("[data-members-button]").click();
        await host.locator("[data-reset-link]").click();
        await host.keyboard.press("Escape");
        await moved(first);
        const second = await roomOf(host);
        expect(urlRoom(host), "the host's address bar shows it").toBe(second);
        await followed(guest);
        await followed(bob);
        expect([urlRoom(guest), urlRoom(bob)]).toEqual([second, second]);
        await expect(guest.locator('[data-access="trusted"]'), "Ada is still trusted").toHaveCount(
          1,
          {
            timeout: 15_000,
          },
        );
        expect(await reaches(guest, host, 10_000)).toBe(true);
        expect(await reaches(host, bob, 10_000)).toBe(true);
        newLink = await copyGuestLink(host);
        const [n, o] = [new URL(newLink), new URL(guestLink)];
        expect(n.searchParams.get("room"), "the guest link is the new one").toBe(second);
        const key = (u: URL, k: string) => new URLSearchParams(u.hash.slice(1)).get(k);
        expect(key(n, "k"), "with a new key").not.toBe(key(o, "k"));
        expect(key(n, "rt"), "and a token for the new relay room").not.toBe(key(o, "rt"));
        expect(await roomOf(cy), "Cy, knocking, is left behind").toBe(first);
        await cy.waitForTimeout(2000);
        expect(await hostOnline(cy), "with no host").toBe(false);
      });

      await test.step("removing Bob resets it again; he gets no handover", async () => {
        const second = await roomOf(host);
        await bob.evaluate(() => {
          (window as any).room.participant.leaveRoom = () => {};
          const room = (window as any).room;
          const got: string[] = ((window as any).received = []);
          for (const [name, channel] of Object.entries<any>(room.participant.actions)) {
            const handler = channel.onMessage;
            if (handler)
              channel.onMessage = (data: any, context: unknown) => {
                got.push(name === "admission" ? `admission:${data?.t}` : name);
                return handler(data, context);
              };
          }
        });
        await remove(host, bob);
        await moved(second);
        await followed(guest);
        expect(await roomOf(bob), "Bob stays in the old room").toBe(second);
        expect(await bob.evaluate(() => (window as any).received)).not.toContain("admission:moved");
        await expect.poll(() => hostOnline(bob), { timeout: 15_000 }).toBe(false);
        expect(await reaches(host, bob, 3000)).toBe(false);
        expect(
          await bob.evaluate(() => (window as any).room.peerIds().length),
          "nobody is left there",
        ).toBe(0);
      });

      await test.step("old links lead nowhere", async () => {
        for (const link of [guestLink, newLink]) {
          const stranger = await open(browser, link, "Mallory", "#ef4444", testInfo);
          await expect(stranger.locator("[data-lobby]")).toBeVisible({ timeout: 15_000 });
          await stranger.waitForTimeout(8000);
          expect(await hostOnline(stranger)).toBe(false);
          await expect(stranger.locator("[data-board]")).toHaveCount(0);
          await stranger.context().close();
        }
      });

      await test.step("reloads stay in: a member's, and the host's from the old link", async () => {
        const third = await roomOf(host);
        await guest.reload();
        await followed(guest);
        await expect(guest.locator("[data-board]")).toBeVisible({ timeout: 30_000 });
        await host.goto(serve.link);
        await expect(connected(host)).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => roomOf(host), { timeout: 15_000 }).toBe(third);
        expect(urlRoom(host)).toBe(third);
        await followed(guest);
        expect(await reaches(guest, host, 10_000)).toBe(true);
      });
      await bob.context().close();
      await cy.context().close();
    });
  });
