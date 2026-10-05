/**
 * The room's named channels on its transport (`transport/`, ADR 0008), and
 * what the host and a guest say on them before the guest is in. The
 * participant opens them (`participant.ts`); the host's authority takes its
 * side of them (`authority.ts`).
 */

import type { PeerProof } from "../../../shared/identity";
import type { Identity } from "../link-types";
import type { Channel, RequestChannel } from "../transport/channel";

export interface Channels {
  readonly hello: Channel;
  readonly identify: Channel;
  readonly admission: Channel;
  readonly broadcast: Channel;
  readonly update: Channel<Uint8Array>;
  readonly sync: Channel<Uint8Array>;
  readonly presence: Channel<Uint8Array>;
  readonly request: RequestChannel;
}

/** A room we joined: its channels, and the peers we reach there now. */
export interface Joined {
  readonly channels: Channels;
  peers(): string[];
}

/** The host's hello: it proves it is the host, and asks who we are. */
export interface Hello {
  readonly signature: string;
  /** For the guest to sign, proving its browser key. */
  readonly nonce: string;
}

/** A guest's answer to the hello: its proof, and the name it knocks with. */
export interface Identify extends PeerProof, Identity {}

/** Channels carry JSON as `Payload`; what we send is typed by the protocol. */
export const json = <T>(value: T) => value as never;
