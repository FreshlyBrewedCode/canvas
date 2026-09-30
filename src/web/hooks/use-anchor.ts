import { useEffect, useLayoutEffect, useRef } from "react";
import type * as Y from "yjs";

import type { BoardViewport } from "@/hooks/use-board-viewport";
import { OWN, type Frame } from "@/lib/board";
import { showsAny } from "@/lib/viewport";

/**
 * Views are anchored to the structure (ADR 0010, decision 8): when the layout
 * changes under us — someone reorders, adds, closes or resizes frames — the
 * frame we are on stays where it was on our screen, and the rest moves around
 * it. Our own hands' changes (`OWN`) move what they move; so does a view we
 * follow, and a frame out of view doesn't hold the board still.
 *
 * `current` is the frame we are on: the one full screen shows, else the one we
 * occupy.
 */
export function useAnchor(
  doc: Y.Doc,
  frames: ReadonlyArray<Frame>,
  current: () => string | null,
  viewport: Pick<BoardViewport, "screen" | "shift">,
  paused: boolean,
) {
  /** Where the current frame was, as last shown. */
  const seen = useRef<Frame | null>(null);
  /** Whether the changes since then are all ours. */
  const since = useRef<"none" | "own" | "others">("none");
  useEffect(() => {
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin !== OWN) since.current = "others";
      else if (since.current === "none") since.current = "own";
    };
    doc.on("afterTransaction", onTransaction);
    return () => doc.off("afterTransaction", onTransaction);
  }, [doc]);

  const { screen, shift } = viewport;
  useLayoutEffect(() => {
    const id = current();
    const frame = frames.find((f) => f.id === id) ?? null;
    const was = seen.current;
    const { transform, width, height } = screen();
    if (
      frame &&
      was?.id === frame.id &&
      since.current === "others" &&
      !paused &&
      showsAny(transform, was, width, height)
    ) {
      const [dx, dy] = [frame.x - was.x, frame.y - was.y];
      if (dx || dy) shift(dx, dy);
    }
    seen.current = frame;
    since.current = "none";
  });
}
