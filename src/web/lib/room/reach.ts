/**
 * Where a frame's things are, from this room (ADR 0013): `own` is the id of
 * the board's own runtime, what an absent `runtime` means; null until the
 * welcome, or the host, says.
 */

import type * as Y from "yjs";

import { canonical, type Address, type UncheckedAddress } from "../../../shared/address";
import { allFrames, frameReach, type AgentFrame, type Frame } from "../board";

/** The runtime of an address, as writers write it: sessions, kinds and PTYs have no root. */
export function runtimeOf(at: UncheckedAddress, own: string | null): Address {
  const { runtime } = canonical(at, own);
  return runtime === undefined ? {} : { runtime };
}

/**
 * A frame's address as writers write it: what its messages and links name;
 * none on the board's own runtime and working dir.
 */
export function addressOf(frame: Frame, own: string | null): Address {
  switch (frame.type) {
    case "file":
      return canonical(frame, own);
    case "agent":
    case "terminal":
      return runtimeOf(frame, own);
    default:
      return {};
  }
}

/**
 * The frames whose agent, file or terminal is on a runtime we reach: the
 * board's own (decision 7). Nothing is opened, sent or asked for the others;
 * they show as not reachable. What is mirrored of the own runtime is keyed by
 * bare id (`addressKey`), so whatever goes by these frames' ids may too.
 */
export function here(doc: Y.Doc, own: string | null): Frame[] {
  return allFrames(doc).filter((frame) => frameReach(frame, own) === "own");
}

export function agentFrame(doc: Y.Doc, frameId: string): AgentFrame | undefined {
  const frame = allFrames(doc).find((f) => f.id === frameId);
  return frame?.type === "agent" ? frame : undefined;
}
