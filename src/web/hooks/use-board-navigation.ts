import { useCallback, useEffect, useMemo, useRef } from "react";

import type { Go } from "@/components/board-link";
import type { BoardViewport } from "@/hooks/use-board-viewport";
import { allFrames, framesOf } from "@/lib/board";
import { readHash, withTarget, type LinkTarget } from "@/lib/board-link";
import { navigate, type NavigateContext } from "@/lib/navigate";
import type { Room } from "@/lib/room";

/**
 * Following links on the board (ADR 0007), and the page's history of them:
 * each place a link took us is a history entry, its fragment the room's
 * secrets plus the place (`…#k=…&pk=…&frame=abc&lines=3`), so Back goes back
 * and a page URL with a place is a deep link, followed once the board has it.
 */
export function useBoardNavigation(
  room: Room,
  viewport: Pick<BoardViewport, "show">,
  readOnly: boolean,
): Go {
  const latest = useRef({ viewport, readOnly });
  useEffect(() => {
    latest.current = { viewport, readOnly };
  });
  const ctx = useMemo<NavigateContext>(
    () => ({
      doc: room.doc,
      get canEdit() {
        return !latest.current.readOnly;
      },
      focus: (frameId) => {
        // As a press on the frame: claim it if free; if someone holds it, go our own way in it.
        room.focusFrame(frameId);
        room.detach(frameId);
      },
      fit: (box) => latest.current.viewport.show(box),
    }),
    [room],
  );

  const go = useCallback<Go>(
    (link, options) => {
      if (link.kind === "web") {
        window.open(link.url, "_blank", "noopener,noreferrer");
        return;
      }
      const where = navigate(ctx, link.target, options);
      if (!where) return;
      const hash = `#${withTarget(location.hash, where)}`;
      if (hash !== location.hash) history.pushState(null, "", hash);
    },
    [ctx],
  );

  // Back and forward: go where the entry says, without a new entry.
  useEffect(() => {
    const onPop = () => {
      const target = readHash(location.hash);
      if (target) navigate(ctx, target);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [ctx]);

  // A deep link: follow it once the board has what it names.
  const deep = useRef<LinkTarget | null>(readHash(location.hash));
  useEffect(() => {
    const tryDeep = () => {
      const target = deep.current;
      if (!target) return true;
      const ready = target.frame
        ? allFrames(room.doc).some((f) => f.id === target.frame)
        : allFrames(room.doc).length > 0 || room.tree() !== null;
      if (!ready) return false;
      deep.current = null;
      navigate(ctx, target);
      return true;
    };
    if (tryDeep()) return;
    const offTree = room.subscribe("tree", () => tryDeep() && off());
    const onFrames = () => tryDeep() && off();
    const frames = framesOf(room.doc);
    frames.observeDeep(onFrames);
    const off = () => {
      offTree();
      frames.unobserveDeep(onFrames);
    };
    return off;
  }, [room, ctx]);

  return go;
}
