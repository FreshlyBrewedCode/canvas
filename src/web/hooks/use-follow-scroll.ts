import { useEffect, useLayoutEffect } from "react";

import type { FrameScroll } from "@/lib/focus";
import { useFrameFocus, useRoom } from "@/lib/room-context";

/** Something in a frame that scrolls: a DOM scroller, or a terminal's viewport. */
export interface ScrollSurface {
  read(): { top: number; end: boolean };
  write(scroll: { top: number; end?: boolean }): void;
  /** Called on every scroll, whoever moved it. Returns the unsubscribe. */
  onScroll(listener: () => void): () => void;
  /** Where a person's own scrolling (wheel, touch, keys, scrollbar) lands. */
  readonly element: HTMLElement;
}

/** A plain overflow scroller; `end` when within `slack` px of the bottom. */
export function domSurface(element: HTMLElement, slack = 40): ScrollSurface {
  return {
    element,
    read: () => ({
      top: Math.round(element.scrollTop),
      end: element.scrollHeight - element.scrollTop - element.clientHeight < slack,
    }),
    write: ({ top, end }) => {
      element.scrollTop = end ? element.scrollHeight : top;
    },
    onScroll: (listener) => {
      element.addEventListener("scroll", listener, { passive: true });
      return () => element.removeEventListener("scroll", listener);
    },
  };
}

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * A frame's scroll follows its occupant (`focus.ts`): as the occupant we
 * publish where we scroll; following someone, we go where they are. Scrolling
 * ourselves while following stops following there, for us only.
 *
 * `key` names the view (only the same view follows); `version` changes with
 * the content, to re-apply the occupant's place once it has arrived here.
 */
export function useFollowScroll(
  frameId: string,
  key: string,
  surface: () => ScrollSurface | null,
  version?: unknown,
) {
  const room = useRoom();
  const { mine, following } = useFrameFocus(frameId);

  // Occupant: publish, now and on every scroll.
  useEffect(() => {
    const target = surface();
    if (!mine || !target) return;
    let raf = 0;
    const publish = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => room.publishScroll(frameId, { key, ...target.read() }));
    };
    publish();
    const off = target.onScroll(publish);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
    // `surface` is a getter; `version` re-reads it when the content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, frameId, key, mine, version]);

  // Follower: go where the occupant is, whenever that or our content changes.
  useLayoutEffect(() => {
    const target = surface();
    if (!following || !target) return;
    let last: FrameScroll | null = null;
    const apply = () => {
      const scroll = room.occupantScroll(frameId);
      if (!scroll || scroll.key !== key) return;
      last = scroll;
      target.write(scroll);
    };
    apply();
    let raf = 0;
    const unsubscribe = room.subscribe("focus", () => {
      if (room.occupantScroll(frameId) === last) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, frameId, key, following, version]);

  // Our own scrolling, while following: we go our own way here.
  useEffect(() => {
    const element = surface()?.element;
    if (!element) return;
    const detach = () => {
      if (room.frameFocus(frameId).following) room.detach(frameId);
    };
    const onWheel = (event: WheelEvent) => !event.ctrlKey && !event.metaKey && detach();
    // Keys typed into something (a terminal's input) aren't scrolling.
    const onKey = (event: KeyboardEvent) =>
      SCROLL_KEYS.has(event.key) &&
      !(event.target as Element).closest("textarea, input, [contenteditable=true]") &&
      detach();
    // The scrollbar: a press on the scroller itself, not its content.
    const onDown = (event: PointerEvent) => event.target === element && detach();
    const options = { capture: true, passive: true };
    element.addEventListener("wheel", onWheel, options);
    element.addEventListener("touchmove", detach, options);
    element.addEventListener("keydown", onKey, options);
    element.addEventListener("pointerdown", onDown, options);
    return () => {
      element.removeEventListener("wheel", onWheel, options);
      element.removeEventListener("touchmove", detach, options);
      element.removeEventListener("keydown", onKey, options);
      element.removeEventListener("pointerdown", onDown, options);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, frameId, version]);
}
