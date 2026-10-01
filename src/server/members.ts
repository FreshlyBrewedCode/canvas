/**
 * Who may join the board (ADR 0011, decision 2): the browsers the host
 * admitted, by their keys (`web/lib/identity-key.ts`), each with a role.
 *
 *   members.json   fingerprint, public key, name when admitted, role, when
 *
 * Only the host's browser reads and changes it, over the protocol; guests
 * never reach `canvas serve`. Read on every call, as `owners.ts` is. The
 * fingerprint is the server's own, of the key: never one the browser says.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Member, MemberRole } from "../shared/protocol";
import { fingerprint } from "../shared/identity";

const ROLES: ReadonlyArray<MemberRole> = ["view", "edit"];
export const isRole = (role: unknown): role is MemberRole => ROLES.includes(role as MemberRole);

export class Members {
  private readonly path: string;

  /** `root`: the board's `.canvas/` directory. */
  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(root, "members.json");
  }

  list(): Member[] {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Member[];
    } catch {
      return [];
    }
  }

  /** Admit a browser by its key, or give a member a new role and name. */
  async admit(publicKey: string, name: string, role: MemberRole): Promise<Member> {
    if (typeof publicKey !== "string" || !isRole(role)) throw new Error("malformed member");
    const id = await fingerprint(publicKey);
    const member: Member = {
      publicKey,
      fingerprint: id,
      name: String(name ?? "").slice(0, 80),
      role,
      admitted: new Date(this.now()).toISOString(),
    };
    this.save([...this.list().filter((m) => m.fingerprint !== id), member]);
    return member;
  }

  /** False if it isn't a member. */
  setRole(fingerprint: string, role: MemberRole): boolean {
    if (!isRole(role)) throw new Error("malformed role");
    const members = this.list();
    if (!members.some((m) => m.fingerprint === fingerprint)) return false;
    this.save(members.map((m) => (m.fingerprint === fingerprint ? { ...m, role } : m)));
    return true;
  }

  /** False if it wasn't a member. */
  remove(fingerprint: string): boolean {
    const members = this.list();
    const rest = members.filter((m) => m.fingerprint !== fingerprint);
    if (rest.length === members.length) return false;
    this.save(rest);
    return true;
  }

  private save(members: ReadonlyArray<Member>) {
    // Whole or not at all: it is read on every call.
    const temp = `${this.path}.${process.pid}`;
    writeFileSync(temp, JSON.stringify(members, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
