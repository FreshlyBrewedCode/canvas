// For tests: a board as it was laid out before the tree (ADR 0010), frames by
// position, read into the tree as the host migrates it (`tidy`).

import * as Y from "yjs";

import type { Box } from "../../shared/layout";
import { framesOf, tidy, type NewFrame } from "./board";

export type Placed = NewFrame & Box;

/** Put `frames` where they say, then migrate them; their ids, in order. */
export function placeFrames(doc: Y.Doc, frames: ReadonlyArray<Placed>): string[] {
  const ids = frames.map((_, i) => `f${framesOf(doc).size + i + 1}`);
  doc.transact(() =>
    frames.forEach((frame, i) => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({ ...frame, z: i + 1 })) map.set(key, value);
      framesOf(doc).set(ids[i]!, map);
    }),
  );
  tidy(doc);
  return ids;
}
