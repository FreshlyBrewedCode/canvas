/**
 * The signed member list (ADR 0011, decision 5): the peers that are in, with
 * the fingerprints the host verified, signed with the host key. Presence is a
 * mesh between guests; the list is how a guest knows whom to send it to and
 * whose to take — only peers on it, so the lobby gets nobody's and nobody gets
 * the lobby's. It also tells guests each other's fingerprints.
 *
 * The statement is `canvas-members:<room>:<list>`, apart from the host's
 * hello (`canvas-host:`), a peer's proof (`canvas-peer:`) and the owner's
 * (`canvas-owner:`), so no signature passes for another. A list names the
 * host peer that signed it — a guest takes lists only from the host it
 * verified, so none of an earlier host session's can come back into this one
 * — and its version, which must grow: an old list never replaces a newer one.
 * Versions are the host's clock, kept increasing, so they grow across reloads
 * of the host tab too; a guest starts over only with a new host peer.
 */

import { signText } from "./host-key";
import { verify } from "../../shared/identity";
import type { SignedMemberList } from "../../shared/protocol";

export interface MemberList {
  /** The host's peer id: the list is that host session's. */
  readonly host: string;
  readonly version: number;
  /** Fingerprints by peer id, of every peer that is in, the host's own included. */
  readonly members: Readonly<Record<string, string>>;
}

export const membersStatement = (roomId: string, list: string) =>
  `canvas-members:${roomId}:${list}`;

/** The next version after `last`: the clock, unless it would not grow. */
export const nextVersion = (last: number, now = Date.now()) => Math.max(now, last + 1);

export async function signMembers(
  privateKey: JsonWebKey,
  roomId: string,
  list: MemberList,
): Promise<SignedMemberList> {
  const text = JSON.stringify(list);
  return { list: text, signature: await signText(privateKey, membersStatement(roomId, text)) };
}

/**
 * A guest's view of the latest list it verified: whom presence goes to and
 * comes from. Until there is one — in the lobby, before the first — nobody.
 */
export class Members {
  private list: MemberList | null = null;
  /** The last version taken from `host`. */
  private floor = 0;
  private host: string | null = null;

  constructor(
    private readonly roomId: string,
    private readonly hostPublicKey: string,
    private readonly self: string,
  ) {}

  /**
   * A list from `hostPeer`, the host we verified: taken if the host key signed
   * it, for that host, newer than the last. Who joined and left the list if
   * taken, else null.
   */
  async accept(
    signed: SignedMemberList,
    hostPeer: string,
  ): Promise<{ readonly added: string[]; readonly removed: string[] } | null> {
    if (typeof signed?.list !== "string" || typeof signed.signature !== "string") return null;
    const statement = membersStatement(this.roomId, signed.list);
    if (!(await verify(this.hostPublicKey, statement, signed.signature))) return null;
    const list = parse(signed.list);
    if (!list || list.host !== hostPeer) return null;
    if (this.host !== hostPeer) this.reset(hostPeer);
    // Checked after verifying: two lists may verify in either order.
    if (list.version <= this.floor) return null;
    this.floor = list.version;
    const before = new Set(this.peers());
    this.list = list;
    const after = new Set(this.peers());
    return {
      added: [...after].filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !after.has(id)),
    };
  }

  /** Whether presence goes to and comes from `peerId`: it is on the list, and so are we. */
  has(peerId: string): boolean {
    return peerId !== this.self && this.peers().includes(peerId);
  }

  /** The others on the list; nobody unless we are on it too. */
  peers(): string[] {
    const members = this.list?.members ?? {};
    if (!Object.hasOwn(members, this.self)) return [];
    return Object.keys(members).filter((id) => id !== this.self);
  }

  /** Verified fingerprints by peer id, as the list says. */
  fingerprints(): Readonly<Record<string, string>> {
    return this.list?.members ?? {};
  }

  /** Off the list: we left, or a new host takes over (its lists start over). */
  reset(host: string | null = null) {
    this.list = null;
    this.floor = 0;
    this.host = host;
  }
}

function parse(text: string): MemberList | null {
  try {
    const list = JSON.parse(text) as MemberList;
    if (typeof list?.host !== "string" || typeof list.version !== "number") return null;
    if (typeof list.members !== "object" || list.members === null) return null;
    if (Object.values(list.members).some((f) => typeof f !== "string")) return null;
    return list;
  } catch {
    return null;
  }
}
