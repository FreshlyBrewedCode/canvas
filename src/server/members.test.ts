import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEY_ALGORITHM, fingerprint, toBase64Url } from "../shared/identity";
import { Members } from "./members";

const publicKey = async () => {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
  return toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-members-"));
  return { root, members: new Members(root, () => Date.UTC(2026, 9, 1)) };
};

describe("members", () => {
  test("none until the host admits someone", () => {
    expect(setup().members.list()).toEqual([]);
  });

  test("admitting saves the key, its full fingerprint, name and role", async () => {
    const { root, members } = setup();
    const key = await publicKey();
    const member = await members.admit(key, "Ada", "edit");
    expect(member).toEqual({
      publicKey: key,
      fingerprint: await fingerprint(key),
      name: "Ada",
      role: "edit",
      admitted: "2026-10-01T00:00:00.000Z",
    });
    expect(member.fingerprint).toHaveLength(32);
    // Another instance, as another process, reads the same file.
    expect(new Members(root).list()).toEqual([member]);
    expect(JSON.parse(readFileSync(join(root, "members.json"), "utf8"))).toEqual([member]);
  });

  test("admitting a member again replaces it", async () => {
    const { members } = setup();
    const key = await publicKey();
    await members.admit(key, "Ada", "view");
    await members.admit(key, "Ada L.", "edit");
    expect(members.list()).toMatchObject([{ name: "Ada L.", role: "edit" }]);
  });

  test("roles change, members go; unknown fingerprints change nothing", async () => {
    const { members } = setup();
    const ada = await members.admit(await publicKey(), "Ada", "edit");
    const bob = await members.admit(await publicKey(), "Bob", "edit");
    expect(members.setRole(ada.fingerprint, "view")).toBe(true);
    expect(members.setRole("0".repeat(32), "view")).toBe(false);
    expect(members.list().map((m) => [m.name, m.role])).toEqual([
      ["Ada", "view"],
      ["Bob", "edit"],
    ]);
    expect(members.remove(bob.fingerprint)).toBe(true);
    expect(members.remove(bob.fingerprint)).toBe(false);
    expect(members.list().map((m) => m.name)).toEqual(["Ada"]);
  });

  test("only view and edit are saved: trusted never is", async () => {
    const { members } = setup();
    const key = await publicKey();
    // @ts-expect-error not a member role
    await expect(members.admit(key, "Ada", "trusted")).rejects.toThrow();
    const ada = await members.admit(key, "Ada", "view");
    // @ts-expect-error not a member role
    expect(() => members.setRole(ada.fingerprint, "trusted")).toThrow();
    expect(members.list()[0]!.role).toBe("view");
  });
});
