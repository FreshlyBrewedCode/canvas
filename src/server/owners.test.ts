import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEY_ALGORITHM, SIGNATURE, ownerStatement, toBase64Url } from "../shared/identity";
import { Owners, PAIRING_MS, type OwnerAnswer } from "./owners";

/** A browser's key, as `web/lib/identity-key.ts` makes it. */
async function testKey() {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
  const publicKey = toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (text: string) =>
    toBase64Url(
      await crypto.subtle.sign(SIGNATURE, pair.privateKey, new TextEncoder().encode(text)),
    );
  return { publicKey, sign };
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-owners-"));
  let now = 1_000_000;
  const owners = new Owners(root, () => now);
  return { root, owners, later: (ms: number) => (now += ms) };
};

const answer = async (
  key: Awaited<ReturnType<typeof testKey>>,
  nonce: string,
  pair?: string,
): Promise<OwnerAnswer> => ({
  publicKey: key.publicKey,
  signature: await key.sign(ownerStatement("r1", nonce)),
  ...(pair && { pair }),
});

describe("pairing", () => {
  test("the first browser with the code becomes an owner; the code is used up", async () => {
    const { root, owners } = setup();
    const code = owners.pair();
    const first = await testKey();
    const result = await owners.authenticate("r1", "n1", await answer(first, "n1", code));
    expect(result).toMatchObject({ ok: true, paired: true });
    expect(owners.list().map((o) => o.publicKey)).toEqual([first.publicKey]);
    expect(existsSync(join(root, "pairing.json"))).toBe(false);

    const second = await testKey();
    const reused = await owners.authenticate("r1", "n2", await answer(second, "n2", code));
    expect(reused).toMatchObject({ ok: false, reason: expect.stringContaining("used up") });
    expect(owners.list()).toHaveLength(1);
  });

  test("a code runs out after 10 minutes", async () => {
    const { owners, later } = setup();
    const code = owners.pair();
    later(PAIRING_MS + 1);
    expect(owners.pending()).toBe(false);
    const key = await testKey();
    expect((await owners.authenticate("r1", "n", await answer(key, "n", code))).ok).toBe(false);
    expect(owners.list()).toHaveLength(0);
  });

  test("a new code replaces the last, even from another process's Owners", async () => {
    const { root, owners } = setup();
    const old = owners.pair();
    const fresh = new Owners(root).pair();
    const key = await testKey();
    expect((await owners.authenticate("r1", "n", await answer(key, "n", old))).ok).toBe(false);
    expect((await owners.authenticate("r1", "n", await answer(key, "n", fresh))).ok).toBe(true);
  });

  test("an owner signs in without a code, and a code it carries isn't spent", async () => {
    const { owners } = setup();
    const key = await testKey();
    await owners.authenticate("r1", "n1", await answer(key, "n1", owners.pair()));
    const code = owners.pair();
    const again = await owners.authenticate("r1", "n2", await answer(key, "n2", code));
    expect(again).toMatchObject({ ok: true, paired: false });
    expect(owners.pending()).toBe(true);
  });
});

describe("the challenge", () => {
  test("a stranger's key without a code is refused", async () => {
    const { owners } = setup();
    owners.pair();
    const key = await testKey();
    const result = await owners.authenticate("r1", "n", await answer(key, "n"));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("isn't paired") });
  });

  test("a signature over another nonce, room or statement is refused", async () => {
    const { owners } = setup();
    const key = await testKey();
    await owners.authenticate("r1", "n1", await answer(key, "n1", owners.pair()));
    const over = async (text: string) => ({
      publicKey: key.publicKey,
      signature: await key.sign(text),
    });
    for (const signed of [
      await over(ownerStatement("r1", "old")),
      await over(ownerStatement("r2", "n")),
      await over(`canvas-peer:r1:peer:n`),
    ])
      expect((await owners.authenticate("r1", "n", signed)).ok).toBe(false);
  });

  test("an owner's public key with another key's signature is refused", async () => {
    const { owners } = setup();
    const owner = await testKey();
    await owners.authenticate("r1", "n1", await answer(owner, "n1", owners.pair()));
    const thief = await testKey();
    const forged = { publicKey: owner.publicKey, signature: (await answer(thief, "n")).signature };
    expect((await owners.authenticate("r1", "n", forged)).ok).toBe(false);
  });
});
