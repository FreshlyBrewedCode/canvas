/**
 * The host's admission (ADR 0011, decision 2): which connected peers are in,
 * which knock, and what each may do. Pure, for `room.ts` to act on.
 *
 * A peer counts once it proved its browser key (`shared/identity.ts`). If the
 * key is a member's (`canvas serve`'s list, found by the full fingerprint and
 * the key, never the short form), it is in with that member's role; else it
 * knocks, until the host admits or denies it. A peer that was denied, or
 * whose member was removed, is dropped for good: coming again is a reload, a
 * new peer id, a new knock. What a peer may do is read from the member list
 * at every check, so a change takes hold at once.
 */

import type { GuestAccess, GuestRequest, Member } from "../../shared/protocol";
import type { PeerIdentity } from "../../shared/identity";
import type { Identity } from "./link";

/** A verified browser that isn't a member, waiting for the host. */
export interface Knock extends Identity {
  readonly peerId: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** What the host owes a peer after a change. */
export type Step =
  /** In, for the first time on this connection: send it the board. */
  | { readonly t: "admit"; readonly peerId: string; readonly access: GuestAccess }
  /** Its role changed. */
  | {
      readonly t: "access";
      readonly peerId: string;
      readonly access: GuestAccess;
      readonly was: GuestAccess;
    }
  /** Not a member: it waits in the lobby. */
  | { readonly t: "knock"; readonly knock: Knock }
  /** Its member was removed: tell it, and drop it. */
  | { readonly t: "cut"; readonly peerId: string };

interface Entry {
  readonly knock: Knock;
  /** What it was last told it may do; null while it knocks. */
  access: GuestAccess | null;
}

export class Admissions {
  private members: ReadonlyArray<Member> = [];
  private readonly peers = new Map<string, Entry>();
  private readonly dropped = new Set<string>();

  /** `canvas serve`'s member list changed: who is in, who changed, who is out. */
  setMembers(members: ReadonlyArray<Member>): Step[] {
    this.members = members;
    const steps: Step[] = [];
    for (const [peerId, entry] of this.peers) {
      const access = this.role(entry.knock);
      if (access && !entry.access) steps.push({ t: "admit", peerId, access });
      else if (access && entry.access !== access)
        steps.push({ t: "access", peerId, access, was: entry.access! });
      else if (!access && entry.access) {
        steps.push({ t: "cut", peerId });
        this.drop(peerId);
        continue;
      }
      entry.access = access;
    }
    return steps;
  }

  /** A peer proved its key: in if a member's, else it knocks. Nothing for a dropped peer. */
  arrive(peerId: string, identity: PeerIdentity, who: Identity): Step[] {
    if (this.dropped.has(peerId)) return [];
    const knock: Knock = { peerId, ...identity, name: who.name, color: who.color };
    const access = this.role(knock);
    this.peers.set(peerId, { knock, access });
    return [access ? { t: "admit", peerId, access } : { t: "knock", knock }];
  }

  /** The host turned a knock away; false if it wasn't knocking. */
  deny(peerId: string): boolean {
    const entry = this.peers.get(peerId);
    if (!entry || entry.access) return false;
    this.drop(peerId);
    return true;
  }

  /** The peer left. */
  leave(peerId: string) {
    this.peers.delete(peerId);
  }

  /** The transport was left: everyone comes again. */
  clear() {
    this.peers.clear();
    this.dropped.clear();
  }

  /**
   * What `peerId` may do now; null unless it is in. The seam for trusted
   * (decision 4): granted for one host session, on top of this.
   */
  access(peerId: string): GuestAccess | null {
    const entry = this.peers.get(peerId);
    return entry?.access ? this.role(entry.knock) : null;
  }

  isDropped(peerId: string) {
    return this.dropped.has(peerId);
  }

  /** The peers that are in. */
  admitted(): string[] {
    return [...this.peers].flatMap(([peerId, entry]) => (entry.access ? [peerId] : []));
  }

  /** The fingerprint of each peer that is in. */
  fingerprints(): Record<string, string> {
    return Object.fromEntries(
      [...this.peers].flatMap(([peerId, e]) => (e.access ? [[peerId, e.knock.fingerprint]] : [])),
    );
  }

  knocks(): Knock[] {
    return [...this.peers.values()].flatMap((e) => (e.access ? [] : [e.knock]));
  }

  /** The knock of a peer still knocking. */
  knock(peerId: string): Knock | undefined {
    const entry = this.peers.get(peerId);
    return entry && !entry.access ? entry.knock : undefined;
  }

  private role(identity: PeerIdentity): GuestAccess | null {
    const member = this.members.find(
      (m) => m.fingerprint === identity.fingerprint && m.publicKey === identity.publicKey,
    );
    return member?.role ?? null;
  }

  private drop(peerId: string) {
    this.peers.delete(peerId);
    this.dropped.add(peerId);
  }
}

/** Board edits from a peer with `access` are applied. */
export const mayEdit = (access: GuestAccess | null) => access === "edit" || access === "trusted";

/**
 * Whether a peer with `access` may ask for `request`: refused (why), or
 * allowed, with or without the host's approval first.
 */
export function check(
  access: GuestAccess | null,
  request: GuestRequest,
):
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly approve: boolean } {
  if (!access) return { ok: false, error: "the host hasn't let you in" };
  if (access === "view") return { ok: false, error: "the board is read-only for you" };
  if (request.t === "term-input" && access !== "trusted")
    return { ok: false, error: "typing into terminals needs trusted access" };
  return { ok: true, approve: access === "edit" && request.t !== "agent-cancel" };
}
