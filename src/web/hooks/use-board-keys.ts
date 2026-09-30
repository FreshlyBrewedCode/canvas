import { useEffect, useRef } from "react";

import { FRAME_KINDS } from "@/components/frame-shell";
import { typesText, type BoardViewport } from "@/hooks/use-board-viewport";
import type { Fullscreen } from "@/hooks/use-fullscreen";
import {
  addFrame,
  allFrames,
  DEFAULT_SIZE,
  moveFrame,
  newFrame,
  own,
  removeFrame,
  type Board,
  type Frame,
  type FrameType,
} from "@/lib/board";
import type { Room } from "@/lib/room";
import { fitRects, inView, viewRect, type Transform } from "@/lib/viewport";
import { neighbour, nudge, type Direction } from "../../shared/layout";

/** W A S D, and vim's H J K L. By the key's place, whatever the keyboard's layout. */
const DIRECTIONS: Readonly<Record<string, Direction>> = {
  KeyW: "up",
  KeyK: "up",
  KeyA: "left",
  KeyH: "left",
  KeyS: "down",
  KeyJ: "down",
  KeyD: "right",
  KeyL: "right",
};

export interface BoardKeys {
  readonly room: Room;
  readonly board: Board;
  readonly fullscreen: Fullscreen;
  readonly viewport: Pick<BoardViewport, "screen" | "transform" | "glide">;
  readonly readOnly: boolean;
  /** A new frame of a kind beside the frame we are in, as the toolbar adds it. */
  readonly create: (type: FrameType) => void;
}

/**
 * The keyboard is moves over the tree, for the left hand (ADR 0010, decision
 * 9), unless typing or drawing:
 *
 * - W A S D (H J K L): to the neighbouring frame that way (`neighbour`),
 *   occupying it as a press does; the view goes along if it is off screen.
 *   In full screen, left and right go along its row
 * - Shift + W A S D: the current frame that way (`nudge`)
 * - Q / E: the cluster before / after
 * - F: full screen on the current frame, or back; Shift + F: the whole board,
 *   where W A S D go on without leaving it, and again, back (to the frame
 *   we are on by then)
 * - 1 – 5: a new frame of a kind beside the current one
 * - Shift + X: close the current frame, on to its neighbour (in full screen,
 *   the next of its row, as full screen hands over)
 * - Esc: out of a field, to the board, so the keys work again (a terminal
 *   keeps its Esc)
 *
 * The current frame is full screen's, else the one we occupy.
 */
export function useBoardKeys(keys: BoardKeys) {
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });

  useEffect(() => {
    /** Shift + F's whole board: the view it fitted, and where we were, on which frame. */
    let overview: {
      fitted: Transform;
      before: Transform;
      frame: string | null;
      fullscreen: boolean;
    } | null = null;
    /** Whether we are in the whole board still: no pan or zoom since. */
    const overviewing = () =>
      !!overview && sameView(latest.current.viewport.transform(), overview.fitted);

    const current = () => {
      const { fullscreen, room } = latest.current;
      return fullscreen.current ?? room.ownFrame();
    };
    /** With no current frame: the one nearest the middle of the view. */
    const middle = (): string | null => {
      const { board, viewport } = latest.current;
      const { transform, width, height } = viewport.screen();
      const view = viewRect(transform, width, height);
      const [cx, cy] = [view.x + view.w / 2, view.y + view.h / 2];
      const off = (f: Frame) => Math.hypot(f.x + f.w / 2 - cx, f.y + f.h / 2 - cy);
      return (
        board.frames.reduce<Frame | null>((a, b) => (!a || off(b) < off(a) ? b : a), null)?.id ??
        null
      );
    };
    /** A view of a frame: centred at the zoom `t` if it fits there readably, else fitted. */
    const onto = (frame: Frame, t: Transform): Transform | null => {
      const { width, height } = latest.current.viewport.screen();
      return t.scale >= 0.5 && frame.w * t.scale <= width && frame.h * t.scale <= height
        ? {
            ...t,
            x: width / 2 - (frame.x + frame.w / 2) * t.scale,
            y: height / 2 - (frame.y + frame.h / 2) * t.scale,
          }
        : fitRects([frame], width, height);
    };
    /** Bring a frame into view, unless it is there to read already; in the whole board, at all. */
    const bring = (frame: Frame) => {
      const { viewport } = latest.current;
      const { transform: t, width, height } = viewport.screen();
      if (inView(t, frame, width, height, overviewing() ? 0 : undefined)) return;
      const to = onto(frame, t);
      if (to) viewport.glide(to);
    };
    /** Go to a frame: in full screen, full screen on it; else occupy it and see it. */
    const go = (id: string) => {
      const { fullscreen, room } = latest.current;
      if (fullscreen.row) return fullscreen.show(id);
      room.focusFrame(id);
      room.detach(id);
      const frame = allFrames(room.doc).find((f) => f.id === id);
      if (frame) bring(frame);
    };

    const walk = (direction: Direction) => {
      const { board, fullscreen } = latest.current;
      const id = current();
      if (!id) {
        const start = middle();
        return start && go(start);
      }
      if (fullscreen.row && (direction === "left" || direction === "right"))
        return fullscreen.step(direction === "left" ? -1 : 1);
      const next = neighbour(board.layout, id, direction);
      if (next) go(next);
    };
    const shove = (direction: Direction) => {
      const { board, room, readOnly } = latest.current;
      const id = current();
      const target = id && !readOnly ? nudge(board.layout, id, direction) : null;
      if (!id || !target) return;
      own(room.doc, () => moveFrame(room.doc, id, target));
      go(id);
    };
    const cluster = (step: 1 | -1) => {
      const { clusters, frames } = latest.current.board.layout;
      const id = current();
      const at = id ? clusters.findIndex((k) => k.id === frames.get(id)?.cluster.id) : -1;
      const next = at < 0 ? (step > 0 ? clusters[0] : clusters.at(-1)) : clusters[at + step];
      const first = next?.rows[0]?.columns[0]?.frames[0];
      if (first) go(first.id);
    };
    const toggleFullscreen = () => {
      const { fullscreen } = latest.current;
      if (fullscreen.row) return fullscreen.exit();
      const id = current();
      if (id) fullscreen.show(id);
    };
    const toggleOverview = () => {
      const { board, fullscreen, viewport } = latest.current;
      const now = viewport.transform();
      if (overviewing()) {
        // Back where we were, on the frame we are on now: W A S D may have gone on.
        const back = overview!;
        overview = null;
        const id = current();
        const frame = board.frames.find((f) => f.id === id);
        if (back.fullscreen && id) fullscreen.show(id);
        else if (!frame || id === back.frame) viewport.glide(back.before);
        else viewport.glide(onto(frame, back.before) ?? back.before);
        return;
      }
      const { width, height } = viewport.screen();
      const fitted = fitRects(board.frames, width, height);
      if (!fitted) return;
      overview = { fitted, before: now, frame: current(), fullscreen: !!fullscreen.current };
      fullscreen.leave();
      viewport.glide(fitted);
    };
    const close = () => {
      const { board, fullscreen, room, readOnly } = latest.current;
      const id = current();
      if (!id || readOnly) return;
      const next = fullscreen.row
        ? null
        : (["left", "right", "up", "down"] as const)
            .map((d) => neighbour(board.layout, id, d))
            .find((n) => n && n !== id);
      own(room.doc, () => removeFrame(room.doc, id));
      if (next) go(next);
    };
    const add = (type: FrameType) => {
      const { fullscreen, room, create, readOnly } = latest.current;
      if (readOnly) return;
      const id = fullscreen.current;
      const frame = id && fullscreen.row?.frames.find((f) => f.id === id);
      if (!frame) return create(type);
      const size = { w: DEFAULT_SIZE[type].w, h: frame.h };
      const added = own(room.doc, () =>
        addFrame(
          room.doc,
          newFrame(type, allFrames(room.doc)),
          { anchor: frame.id, side: "right" },
          size,
        ),
      );
      fullscreen.show(added);
    };

    const onKey = (event: KeyboardEvent) => {
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || typesText(target)) return;
      if (target.closest("[data-drawing-editor], [role=dialog]")) return;
      if (event.ctrlKey || event.metaKey) return;
      const { code, shiftKey: shift, altKey: alt } = event;
      const direction = DIRECTIONS[code];
      const kind = /^Digit([1-5])$/.exec(code)?.[1];
      if (alt) {
        // Alt + ← / → go along full screen's row. They are the browser's Back and Forward too.
        const { fullscreen } = latest.current;
        if (!fullscreen.row || (code !== "ArrowLeft" && code !== "ArrowRight")) return;
        fullscreen.step(code === "ArrowLeft" ? -1 : 1);
      } else if (direction) {
        if (shift) shove(direction);
        else walk(direction);
      } else if ((code === "KeyQ" || code === "KeyE") && !shift) {
        cluster(code === "KeyQ" ? -1 : 1);
      } else if (code === "KeyF") {
        if (shift) toggleOverview();
        else toggleFullscreen();
      } else if (code === "KeyX" && shift) {
        close();
      } else if (kind && !shift) {
        add(FRAME_KINDS[Number(kind) - 1]!.type);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };

    // Esc leaves a field for the board, after the field had its say (a comment
    // being written cancels). A terminal keeps it: programs in it use Esc.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !typesText(field)) return;
      if (field.closest(".xterm, [data-drawing-editor], [role=dialog]")) return;
      field.blur();
    };

    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keydown", onEscape);
    };
  }, []);
}

const sameView = (a: Transform, b: Transform) =>
  Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
