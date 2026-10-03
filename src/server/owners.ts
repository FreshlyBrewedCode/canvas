/**
 * Who may be the host (ADR 0011, decision 3): the browsers paired with this
 * `canvas serve`, by their keys (`web/lib/identity-key.ts`).
 *
 *   owners.json    the paired browsers: public key, fingerprint, when
 *   pairing.json   the one pending pairing code and when it runs out
 *
 * A pairing code is random, good for 10 minutes and for one use: the first
 * browser to present it becomes an owner. The code lives in a file, read on
 * every attempt, so `canvas pair` in another process gives a running server
 * its new code; a new code replaces the last.
 *
 * Every host socket answers a challenge: it signs `canvas-owner:<room>:<nonce>`
 * (`shared/identity.ts`), so the signature can't stand in for a join proof.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, ownerStatement, toBase64Url, verify } from "../shared/identity";

export const PAIRING_MS = 10 * 60_000;

export interface Owner {
  readonly publicKey: string;
  readonly fingerprint: string;
  /** ISO time it paired. */
  readonly paired: string;
}

interface Pairing {
  readonly code: string;
  /** ms since epoch. */
  readonly expires: number;
}

/** A host socket's answer to its challenge. */
export interface OwnerAnswer {
  readonly publicKey: string;
  readonly signature: string;
  /** A pairing code, from the link's fragment. */
  readonly pair?: string;
}

export type AuthResult =
  | { readonly ok: true; readonly owner: Owner; readonly paired: boolean }
  | { readonly ok: false; readonly reason: string };

export class Owners {
  private readonly ownersPath: string;
  private readonly pairingPath: string;

  /** `root`: the board's `.canvas/` directory. */
  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.ownersPath = join(root, "owners.json");
    this.pairingPath = join(root, "pairing.json");
  }

  list(): Owner[] {
    return existsSync(this.ownersPath)
      ? (JSON.parse(readFileSync(this.ownersPath, "utf8")) as Owner[])
      : [];
  }

  /** A fresh pairing code, replacing any pending one. */
  pair(): string {
    const code = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const pairing: Pairing = { code, expires: this.now() + PAIRING_MS };
    // Whole or not at all: a running server may read it any moment.
    const temp = `${this.pairingPath}.${process.pid}`;
    writeFileSync(temp, JSON.stringify(pairing), { mode: 0o600 });
    renameSync(temp, this.pairingPath);
    return code;
  }

  /** Whether a pairing code is pending and still good. */
  pending(): boolean {
    const pairing = this.pairing();
    return pairing !== null && pairing.expires > this.now();
  }

  /**
   * Check a socket's answer to `nonce`: an owner's key, or any key with the
   * pending code, which pairs it (and uses the code up). An owner's answer
   * leaves a code it carries alone: reloading a pairing link burns nothing.
   */
  async authenticate(roomId: string, nonce: string, answer: OwnerAnswer): Promise<AuthResult> {
    if (typeof answer?.publicKey !== "string" || typeof answer.signature !== "string")
      return { ok: false, reason: "malformed answer" };
    if (!(await verify(answer.publicKey, ownerStatement(roomId, nonce), answer.signature)))
      return { ok: false, reason: "the signature doesn't verify" };
    const id = await fingerprint(answer.publicKey);
    // From here on synchronous: two sockets can't both use one code.
    const known = this.list().find((owner) => owner.fingerprint === id);
    if (known) return { ok: true, owner: known, paired: false };
    if (typeof answer.pair !== "string")
      return {
        ok: false,
        reason: "this browser isn't paired with canvas serve: run canvas pair and open its link",
      };
    const pairing = this.pairing();
    if (!pairing || pairing.code !== answer.pair || pairing.expires <= this.now())
      return {
        ok: false,
        reason: "this pairing code is used up or expired: run canvas pair for a new one",
      };
    rmSync(this.pairingPath, { force: true });
    const owner: Owner = {
      publicKey: answer.publicKey,
      fingerprint: id,
      paired: new Date(this.now()).toISOString(),
    };
    writeFileSync(this.ownersPath, JSON.stringify([...this.list(), owner], null, 2), {
      mode: 0o600,
    });
    return { ok: true, owner, paired: true };
  }

  private pairing(): Pairing | null {
    try {
      return JSON.parse(readFileSync(this.pairingPath, "utf8")) as Pairing;
    } catch {
      return null;
    }
  }
}
