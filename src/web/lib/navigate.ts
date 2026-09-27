/**
 * Following a link to a place on the board (ADR 0007). Going somewhere is
 * yours, as if you had clicked the frame and scrolled it: your view moves to
 * the frame, you occupy it if it is free or go your own way in it if someone
 * else does, and lines or a heading are scrolled to — and the lines selected
 * — for you only. What the board shows is shared, as in the tree: a file no
 * frame shows opens in a new one beside the link's frame, a frame is pointed
 * at the file the link names, and lines mean its source, a heading its
 * preview.
 */

import type * as Y from "yjs";

import { placeNew } from "../../shared/layout";
import {
  addFrame,
  allFrames,
  DEFAULT_SIZE,
  fileView,
  isMarkdown,
  raiseFrame,
  updateFrame,
  type Frame,
  type LineRange,
} from "./board";
import type { LinkTarget } from "./board-link";
import { commentsOf } from "./comments";
import { requestReveal } from "./reveal";

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** What following a link needs of the board, the room and the viewport. */
export interface NavigateContext {
  readonly doc: Y.Doc;
  /** May we change the board (open or retarget frames)? */
  readonly canEdit: boolean;
  /** Claim the frame if it is free; follow whoever holds it otherwise (`Room.focusFrame`). */
  readonly focus: (frameId: string) => void;
  readonly fit: (box: Box) => void;
  /** Where a new frame goes with no frame to put it beside. */
  readonly centre: () => { readonly x: number; readonly y: number };
}

export interface NavigateOptions {
  /** The frame the link is in: new frames go beside it. */
  readonly from?: string | null;
  /** Show the file in `from` itself, as a page's link does (HTML previews). */
  readonly inPlace?: boolean;
}

/**
 * Go to `target`. Returns where we went, with the frame resolved — for the
 * page history — or null if there is nothing there we may show.
 */
export function navigate(
  ctx: NavigateContext,
  target: LinkTarget,
  { from = null, inPlace = false }: NavigateOptions = {},
): LinkTarget | null {
  const frames = allFrames(ctx.doc);
  let { path, lines, heading } = target;

  if (target.frame && target.comment) {
    const comment = commentsOf(ctx.doc, target.frame).get(target.comment);
    if (comment) {
      path = comment.path;
      lines = { start: comment.start, end: comment.end };
    }
  }

  let frame: Frame | undefined;
  if (target.frame) frame = frames.find((f) => f.id === target.frame);
  else if (path) frame = pickFrame(frames, path, inPlace ? from : null, from);
  if (target.frame && !frame) return null;
  // Lines or a heading of a file frame, without a path: of the file it shows.
  if (frame?.type === "file" && !path && (lines || heading)) path = frame.path || undefined;

  if (!frame) {
    // No frame shows the file: open one beside the link.
    if (!path || !ctx.canEdit) return null;
    const box = newFrameBox(ctx, frames, from);
    const id = addFrame(
      ctx.doc,
      {
        type: "file",
        path,
        title: basename(path),
        view: viewFor(path, lines, heading),
        ...box.rect,
      },
      box.patches,
    );
    frame = allFrames(ctx.doc).find((f) => f.id === id)!;
  } else if (frame.type === "file" && path) {
    const patch = retarget(frame, path, lines, heading);
    if (patch) {
      if (!ctx.canEdit) return null;
      updateFrame(ctx.doc, frame.id, patch);
    }
  }

  if (ctx.canEdit) raiseFrame(ctx.doc, frame.id);
  ctx.fit(frame);
  ctx.focus(frame.id);
  if (frame.type === "file" && path && (lines || heading))
    requestReveal(frame.id, { path, ...(lines && { lines }), ...(heading && { heading }) });
  return {
    frame: frame.id,
    ...(path && { path }),
    ...(lines && { lines }),
    ...(heading && { heading }),
    ...(target.comment && { comment: target.comment }),
  };
}

/**
 * The frame to show `path` in: `inPlace` if given; else the link's own frame
 * if it shows it, else the nearest that does.
 */
function pickFrame(
  frames: ReadonlyArray<Frame>,
  path: string,
  inPlace: string | null,
  from: string | null,
): Frame | undefined {
  if (inPlace) {
    const own = frames.find((f) => f.id === inPlace);
    if (own?.type === "file") return own;
  }
  const showing = frames.filter((f) => f.type === "file" && f.path === path);
  const origin = frames.find((f) => f.id === from);
  if (!origin) return showing[0];
  return showing.sort((a, b) => distance(a, origin) - distance(b, origin))[0];
}

/** What to change so a file frame shows `path` the way a link asks; null if it does. */
function retarget(
  frame: Extract<Frame, { type: "file" }>,
  path: string,
  lines: LineRange | undefined,
  heading: string | undefined,
): Record<string, unknown> | null {
  if (frame.path !== path)
    return {
      path,
      lines: null,
      view: viewFor(path, lines, heading),
      // A list's frame keeps the title its agent gave it.
      ...(!frame.files?.length && { title: basename(path) }),
    };
  const view = fileView(frame);
  if (lines && view === "preview") return { view: "source" };
  if (heading && isMarkdown(path) && view === "source") return { view: "preview" };
  return null;
}

/** Lines mean the source; otherwise the file's default. */
const viewFor = (path: string, lines?: LineRange, heading?: string) =>
  lines ? "source" : heading && isMarkdown(path) ? "preview" : null;

function newFrameBox(ctx: NavigateContext, frames: ReadonlyArray<Frame>, from: string | null) {
  const size = DEFAULT_SIZE.file;
  if (from && frames.some((f) => f.id === from))
    return placeNew(frames, { anchor: from, side: "right" }, size);
  const centre = ctx.centre();
  return {
    rect: {
      x: Math.round(centre.x - size.w / 2),
      y: Math.round(centre.y - size.h / 2),
      ...size,
    },
    patches: [],
  };
}

const distance = (a: Box, b: Box) =>
  Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
