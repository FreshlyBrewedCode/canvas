import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { typesText, type BoardViewport } from "@/hooks/use-board-viewport";
import { allFrames, type Frame } from "@/lib/board";
import {
  currentIn,
  fullscreenRow,
  fullscreenTransform,
  standIn,
  stillFullscreen,
  type FullscreenRow,
} from "@/lib/fullscreen";
import type { Room } from "@/lib/room";
import type { Transform } from "@/lib/viewport";

/**
 * Full screen (finding 20): our own view of one row, at 100%, its top under
 * the top bar and its frames as tall as the screen. Only we see it: nothing of
 * it is in the board doc or presence. Panning goes along the row only; a zoom,
 * or anything else that leaves the row's top, ends it where it is. Esc and ✕
 * end it too, gliding back to the view we went full screen from. A frame of the
 * row removed hands over to the next (`standIn`); the row's last ends it.
 *
 * F over a frame (or its header's button) goes full screen on it; h / l and
 * Alt + ← / → glide to the frame before or after. Going to a frame claims it,
 * as a press on it does (`focus.ts`).
 */
export interface Fullscreen {
  /** The row while on: the tree's, by its id, whoever changes it. */
  row: FullscreenRow<Frame> | null;
  /** The frame we are on while on: the one we went to, or panned to the middle. */
  current: string | null;
  /** The screen's height while on: the row's frames are as tall. */
  height: number;
  /** Go full screen on a frame, or to another frame of the row. */
  show: (frameId: string) => void;
  /**
   * Go full screen on the frame someone we follow is on: as `show`, but not
   * our own move, and without claiming the frame.
   */
  lead: (frameId: string) => void;
  /** The frame before (-1) or after (1) the one we are on. */
  step: (direction: 1 | -1) => void;
  /** End it, gliding back to where we went full screen from. */
  exit: () => void;
  /** End it where we are: something else takes the view. */
  leave: () => void;
}

export function useFullscreen(
  room: Room,
  frames: ReadonlyArray<Frame>,
  viewport: Pick<
    BoardViewport,
    "glide" | "lockVertical" | "onOwnMove" | "transform" | "screen" | "subscribe" | "wrapRef"
  >,
): Fullscreen {
  const [at, setAt] = useState<{ row: string; frame: string } | null>(null);
  // Null once the row has no frames left.
  const row = useMemo(() => (at ? fullscreenRow(frames, at.row) : null), [frames, at]);
  const on = row !== null;
  const { glide, lockVertical, onOwnMove, transform, screen, subscribe, wrapRef } = viewport;
  /** The row's top, as last shown. */
  const top = useRef(0);
  const [height, setHeight] = useState(0);
  /** Our view before full screen: Esc and ✕ go back to it. */
  const before = useRef<Transform | null>(null);

  /** Go to a frame of the board, from the doc: a frame added a moment ago is there already. */
  const goTo = useCallback(
    (id: string, ours = true) => {
      const board = allFrames(room.doc);
      const frame = board.find((f) => f.id === id);
      const target = frame && fullscreenRow(board, frame.row);
      if (!frame || !target) return false;
      before.current ??= transform();
      top.current = target.top;
      setHeight(screen().height);
      setAt({ row: frame.row, frame: id });
      glide(fullscreenTransform(frame, target.top, screen().width), ours);
      return true;
    },
    [room, glide, screen, transform],
  );
  const lead = useCallback((id: string) => void goTo(id, false), [goTo]);
  const show = useCallback(
    (id: string) => {
      if (!goTo(id)) return;
      // As a press on the frame: claim it if free; if someone holds it, go our own way in it.
      room.focusFrame(id);
      room.detach(id);
    },
    [room, goTo],
  );
  const leave = useCallback(() => {
    before.current = null;
    setAt(null);
  }, []);
  const exit = useCallback(() => {
    const back = before.current;
    leave();
    if (back) glide(back);
  }, [leave, glide]);

  const latest = useRef(row);
  useEffect(() => {
    latest.current = row;
  });
  // The frame we are on left the row (closed, or moved elsewhere, by us or
  // anyone): on to the next of the row as it was, before a paint without it.
  // The row's last gone ends it.
  const order = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (!at) return;
    if (row?.frames.some((f) => f.id === at.frame)) {
      order.current = row.frames.map((f) => f.id);
      return;
    }
    const next = standIn(order.current, at.frame, new Set(row?.frames.map((f) => f.id)));
    if (!next || !goTo(next)) exit();
  }, [row, at, goTo, exit]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const frames = latest.current?.frames;
      if (!frames || !at) return;
      const next = frames[frames.findIndex((f) => f.id === at.frame) + direction];
      if (next) show(next.id);
    },
    [show, at],
  );

  // Someone moved the row up or down: stay with it (the view is anchored to
  // our frame already, unless it was ours).
  const rowTop = row?.top;
  useEffect(() => {
    if (rowTop === undefined || rowTop === top.current) return;
    top.current = rowTop;
    const frame = latest.current?.frames.find((f) => f.id === at?.frame);
    if (frame && !stillFullscreen(transform(), rowTop))
      glide(fullscreenTransform(frame, rowTop, screen().width));
  }, [rowTop, at, glide, screen, transform]);

  // Along the row only; zooming, or going anywhere else, ends it.
  useEffect(() => {
    if (!on) return;
    lockVertical(true);
    const off = onOwnMove((glide) => {
      if (!stillFullscreen(transform(), top.current)) return leave();
      // A glide goes to a frame: that one is ours already.
      if (glide) return;
      const frames = latest.current?.frames;
      const middle = frames && currentIn(frames, transform(), screen().width);
      if (middle) setAt((was) => (was && was.frame !== middle ? { ...was, frame: middle } : was));
    });
    return () => {
      off();
      lockVertical(false);
    };
  }, [on, lockVertical, onOwnMove, transform, screen, leave]);

  useEffect(() => {
    if (!on) return;
    const measure = () => setHeight(screen().height);
    measure();
    return subscribe(measure);
  }, [on, screen, subscribe]);

  // Keys, unless they type (a prompt, a terminal, an editor) or draw.
  useEffect(() => {
    const pointer = { x: -1, y: -1 };
    const onPointer = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || typesText(target)) return;
      if (target.closest("[data-drawing-editor], [role=dialog]")) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      const along =
        (plain && event.key === "h") || (event.altKey && event.key === "ArrowLeft")
          ? -1
          : (plain && event.key === "l") || (event.altKey && event.key === "ArrowRight")
            ? 1
            : 0;
      if (on && along) {
        step(along);
      } else if (on && event.key === "Escape") {
        exit();
      } else if (plain && event.key === "f") {
        if (on) exit();
        else {
          const hovered = document.elementFromPoint(pointer.x, pointer.y);
          const frame = hovered?.closest<HTMLElement>("[data-frame]");
          if (!frame?.dataset.frame || !wrapRef.current?.contains(frame)) return;
          show(frame.dataset.frame);
        }
      } else return;
      // Alt + ← is the browser's Back too, which board links use.
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [on, step, exit, show, wrapRef]);

  return { row, current: on ? (at?.frame ?? null) : null, height, show, lead, step, exit, leave };
}

/** For frames: whether full screen shows them, and how. */
export interface FullscreenFrames {
  row: FullscreenRow<Frame> | null;
  height: number;
  show: (frameId: string) => void;
  exit: () => void;
  /** Scroll the view along the row by `dx` px: a frame dragged to the board's side. */
  scroll: (dx: number) => void;
}

const FullscreenContext = createContext<FullscreenFrames>({
  row: null,
  height: 0,
  show: () => {},
  exit: () => {},
  scroll: () => {},
});
export const FullscreenProvider = FullscreenContext.Provider;

/**
 * How full screen shows a frame: `off`, `in` its row (top and height, local
 * to us), or `hidden`, off the row. Terminals keep a height of their own, set
 * by the host's screen: the host's one sizes the terminal for everyone.
 */
export function useFullscreenFrame(frame: Frame): {
  mode: "off" | "in" | "hidden";
  box: { y: number; h: number };
  toggle: () => void;
  /** Go (back) to it in full screen: after it moved along the row. */
  show: () => void;
  scroll: (dx: number) => void;
} {
  const { row, height, show, exit, scroll } = useContext(FullscreenContext);
  const box = { y: frame.y, h: frame.h };
  const here = () => show(frame.id);
  if (!row) return { mode: "off", box, toggle: here, show: here, scroll };
  if (!row.frames.some((f) => f.id === frame.id))
    return { mode: "hidden", box, toggle: exit, show: here, scroll };
  return {
    mode: "in",
    box: { y: row.top, h: frame.type === "terminal" ? (frame.height ?? frame.h) : height },
    toggle: exit,
    show: here,
    scroll,
  };
}
