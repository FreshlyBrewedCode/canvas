/**
 * What a board's link names (`link.ts` reads and writes it), and who we are
 * in it. Types only, without a DOM: the board's authority uses them too
 * (`room/authority.ts`).
 */

import type { RelayVia } from "../../shared/protocol";

export interface RelayLink {
  readonly url: string;
  readonly via: RelayVia;
  readonly token: string;
}

export interface BoardLink {
  readonly roomId: string;
  readonly key: string;
  readonly hostPublicKey: string;
  readonly host: { readonly server: string; readonly pair: string | null } | null;
  readonly relay: RelayLink | null;
}

export interface Identity {
  readonly name: string;
  readonly color: string;
}
