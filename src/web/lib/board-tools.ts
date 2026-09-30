/**
 * The board tools (`shared/board-tools.ts`) run here, in the host's browser,
 * against the board doc — the same doc people edit, so an agent's changes
 * travel to everyone like anyone else's. `canvas serve` relays each call from
 * the agent and has already checked any file path against the shared set.
 *
 * An agent has the board powers of an `edit` guest: it opens, changes and
 * closes frames, and nothing it does here runs on the machine by itself (a
 * new agent frame gets only a draft; a terminal frame is an idle shell).
 * Results are plain text for the model, and people read them in the thread;
 * a drawing is also shown as an image. What needs Excalidraw (turning an
 * agent's elements or mermaid into Excalidraw's, rendering the image) is
 * async and happens around these calls (`drawing-kit.ts`), so they stay
 * plain functions of the doc.
 */

import type * as Y from "yjs";

import type {
  AddCommentArgs,
  CloseFrameArgs,
  DeleteCommentArgs,
  DrawArgs,
  EditCommentArgs,
  FileListEntry,
  OpenFrameArgs,
  UpdateFrameArgs,
  ViewBoardArgs,
  ViewFrameArgs,
} from "../../shared/board-tools";
import { type Layout, type ResolvedCluster, type Side, type Target } from "../../shared/layout";
import type { AgentInfo } from "../../shared/protocol";
import {
  addFrame,
  allFrames,
  boardLayout,
  DEFAULT_SIZE,
  moveFrame,
  promptText,
  removeFrame,
  updateFrame,
  type FileEntry,
  type Frame,
  type LineRange,
  type NewFrame,
} from "./board";
import {
  addComment,
  editComment,
  mayChange,
  readComments,
  removeComment,
  type Comment,
} from "./comments";
import {
  describeDrawing,
  drawChanges,
  readElements,
  visible,
  writeElements,
  type DrawingElement,
} from "./drawing";
import { checkDisplays, displayPath } from "./file-list";

export interface BoardToolContext {
  readonly doc: Y.Doc;
  /** The calling agent's frame (its session id). */
  readonly self: string;
  readonly agents: ReadonlyArray<AgentInfo>;
  /** An agent frame's session status, if known. */
  readonly status?: (frameId: string) => string | undefined;
}

export interface BoardToolResult {
  /** For the model, and people reading the thread. */
  readonly text: string;
  /** The frame the call opened or changed: the agent works on it now (`focus.ts`). */
  readonly frame?: string;
  /** A drawing frame to show the agent as an image, too. */
  readonly image?: string;
}

/** Run one tool call; throws with a message for the agent when it can't. */
export function runBoardTool(ctx: BoardToolContext, name: string, args: unknown): BoardToolResult {
  const frames = allFrames(ctx.doc);
  const self = frames.find((f) => f.id === ctx.self);
  if (!self) throw new Error("your frame is no longer on the board");
  const input = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "view_board":
      return { text: viewBoard(ctx, frames, input as ViewBoardArgs) };
    case "view_frame":
      return viewFrame(ctx, frames, input as unknown as ViewFrameArgs);
    case "open_frame":
      return openFrame(ctx, frames, input as unknown as OpenFrameArgs);
    case "update_frame":
      return changeFrame(ctx, frames, input as unknown as UpdateFrameArgs);
    case "close_frame":
      return { text: closeFrame(ctx, frames, input as unknown as CloseFrameArgs) };
    case "add_comment":
      return commentOn(ctx, self, frames, input as unknown as AddCommentArgs);
    case "edit_comment":
      return changeComment(ctx, frames, input as unknown as EditCommentArgs);
    case "delete_comment":
      return changeComment(ctx, frames, input as unknown as DeleteCommentArgs);
    case "draw":
      return draw(ctx, frames, input as unknown as DrawArgs);
    default:
      throw new Error(`no tool ${name}`);
  }
}

// ---------------------------------------------------------------------------

function viewBoard(ctx: BoardToolContext, frames: Frame[], args: ViewBoardArgs): string {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const all = boardLayout(ctx.doc).clusters.map((c) => clusterOf(c, byId));
  const mine = all.find((c) => c.frames.some((f) => f.id === ctx.self))!;
  const others = all.filter((c) => c !== mine);
  const full = args.scope === "board";
  const lines = [
    `You are frame [${ctx.self}]. Your cluster, ${count(mine.frames.length, "frame")} in ${count(mine.rows.length, "row")}:`,
    ...rows(ctx, mine),
    "",
    others.length
      ? `${count(others.length, "other cluster")}${full ? "" : ' (scope "board" lists them by row)'}:`
      : "No other clusters.",
    ...others.flatMap((c, i) =>
      full
        ? [`cluster ${i + 1}:`, ...rows(ctx, c)]
        : [`  - ${c.frames.map((f) => describe(ctx, f)).join(" · ")}`],
    ),
    "",
    `Agents you can open: ${ctx.agents.map((a) => `${a.kind} (${a.label})`).join(", ") || "none"}.`,
  ];
  return lines.join("\n");
}

interface Cluster {
  readonly frames: ReadonlyArray<Frame>;
  /** Top to bottom; each left to right. */
  readonly rows: ReadonlyArray<ReadonlyArray<Frame>>;
}

function clusterOf(cluster: ResolvedCluster, frames: ReadonlyMap<string, Frame>): Cluster {
  const rows = cluster.rows.map((r) =>
    r.columns.flatMap((c) => c.frames.flatMap((f) => frames.get(f.id) ?? [])),
  );
  return { frames: rows.flat(), rows };
}

/** Where an agent's new frame goes by default: at the end of its own row. */
function besideSelf(layout: Layout, self: string): Target {
  const row = layout.frames.get(self)!.row;
  const last = row.columns.at(-1)!.frames.at(-1)!;
  return { anchor: last.id, side: "right" };
}

function rows(ctx: BoardToolContext, cluster: Cluster) {
  return cluster.rows.map(
    (row, i) => `  row ${i + 1}: ${row.map((f) => describe(ctx, f)).join(" · ")}`,
  );
}

function describe(ctx: BoardToolContext, frame: Frame): string {
  const parts = [`[${frame.id}]`];
  switch (frame.type) {
    case "agent": {
      parts.push("agent", frame.agent || "(no agent picked)", JSON.stringify(frame.title));
      const status = ctx.status?.(frame.id);
      if (status) parts.push(status);
      break;
    }
    case "file":
      parts.push("file", JSON.stringify(frame.title), frame.path || "(no file picked)");
      if (frame.lines) parts.push(`L${frame.lines.start}-${frame.lines.end}`);
      if (frame.view) parts.push(`(${frame.view})`);
      if (frame.files?.length)
        parts.push(`list of ${frame.files.length}: [${frame.files.map(describeEntry).join(", ")}]`);
      {
        const comments = readComments(ctx.doc, frame.id);
        const outdated = comments.filter((c) => c.outdated).length;
        if (comments.length)
          parts.push(
            `${count(comments.length, "comment")}${outdated ? ` (${outdated} outdated)` : ""} — view_frame lists them`,
          );
      }
      break;
    case "browser":
      parts.push("browser", JSON.stringify(frame.title), frame.url);
      break;
    case "terminal":
      parts.push("terminal", JSON.stringify(frame.title));
      break;
    case "drawing": {
      const n = visible(readElements(ctx.doc, frame.id)).length;
      parts.push("drawing", JSON.stringify(frame.title), n ? count(n, "element") : "empty");
      break;
    }
  }
  if (frame.id === ctx.self) parts.push("(you)");
  else if (frame.origin === ctx.self) parts.push("(opened by you)");
  else if (frame.origin) parts.push(`(opened by agent [${frame.origin}])`);
  return parts.join(" ");
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------

function openFrame(ctx: BoardToolContext, frames: Frame[], args: OpenFrameArgs): BoardToolResult {
  const numbered = (prefix: string, type: Frame["type"]) =>
    `${prefix}-${frames.filter((f) => f.type === type).length + 1}`;
  let frame: NewFrame;
  switch (args.type) {
    case "file": {
      const files = fileList(args.files);
      const first = files?.[0];
      const path = args.path === undefined && first ? first.path : filePath(args.path);
      const lines = args.path === undefined && first ? (first.lines ?? null) : lineRange(args);
      frame = { type: "file", path, title: basename(path), lines: lines ?? null };
      if (files) frame = { ...frame, files };
      break;
    }
    case "browser": {
      const url = webUrl(args.url);
      frame = { type: "browser", url, title: new URL(url).host };
      break;
    }
    case "terminal":
      frame = { type: "terminal", title: numbered("shell", "terminal") };
      break;
    case "drawing":
      frame = { type: "drawing", title: numbered("drawing", "drawing") };
      break;
    case "agent": {
      const kinds = ctx.agents.map((a) => a.kind);
      if (!args.agent || !kinds.includes(args.agent))
        throw new Error(`agent must be one of: ${kinds.join(", ") || "(none installed)"}`);
      frame = { type: "agent", agent: args.agent, title: numbered(args.agent, "agent") };
      break;
    }
    default:
      throw new Error(
        `type ${args.type === undefined ? "is missing" : "must be"}: one of file, browser, ` +
          "terminal, agent, drawing",
      );
  }
  const size = DEFAULT_SIZE[args.type];
  const target = args.next_to
    ? { anchor: known(frames, args.next_to).id, side: side(args.side) }
    : besideSelf(boardLayout(ctx.doc), ctx.self);
  const id = addFrame(
    ctx.doc,
    { ...frame, ...(args.title && { title: args.title }), origin: ctx.self } as NewFrame,
    target,
    size,
  );
  if (args.type === "agent" && args.draft) promptText(ctx.doc, id).insert(0, args.draft);
  if (args.type === "drawing" && args.elements) {
    const { write } = drawChanges([], { add: prepared(args.elements) });
    writeElements(ctx.doc, id, write);
  }
  const where = args.next_to ? `${side(args.side)} of [${args.next_to}]` : "in your cluster";
  return { text: `Opened ${describe(ctx, reread(ctx, id))}, ${where}.`, frame: id };
}

function changeFrame(
  ctx: BoardToolContext,
  frames: Frame[],
  args: UpdateFrameArgs,
): BoardToolResult {
  const frame = known(frames, args.frame);
  const patch: Record<string, unknown> = {};
  const wantsFile =
    args.path !== undefined ||
    args.start_line !== undefined ||
    args.view ||
    args.files ||
    args.comment !== undefined;
  if (wantsFile && frame.type !== "file")
    throw new Error("path, lines, view, files and comment only apply to file frames");
  if (args.comment !== undefined && (args.path !== undefined || args.start_line !== undefined))
    throw new Error("give either a comment or a path and lines, not both");
  if (args.url !== undefined && frame.type !== "browser")
    throw new Error("url only applies to browser frames");

  if (frame.type === "file") {
    if (args.path !== undefined) {
      const path = filePath(args.path);
      const defaultTitle = frame.title === basename(frame.path) || /^files-\d+$/.test(frame.title);
      Object.assign(patch, { path, view: null, lines: lineRange(args) ?? null });
      if (defaultTitle) patch.title = basename(path);
    } else if (args.start_line !== undefined) patch.lines = lineRange(args);
    if (args.comment !== undefined) {
      // Comments show in the source.
      const comment = knownComment(ctx, frame.id, args.comment);
      Object.assign(patch, {
        path: comment.path,
        view: null,
        lines: { start: comment.start, end: comment.end },
      });
      if (frame.title === basename(frame.path) && !frame.files?.length)
        patch.title = basename(comment.path);
    }
    if (args.view) patch.view = args.view;
    if (args.files !== undefined) {
      const files = fileList(args.files);
      patch.files = files;
      // A new list shows its first entry, unless the frame is told what to show.
      const first = files?.[0];
      if (first && args.path === undefined && !files.some((e) => e.path === frame.path))
        Object.assign(patch, { path: first.path, lines: first.lines ?? null, view: null });
    }
  }
  if (frame.type === "browser" && args.url !== undefined) patch.url = webUrl(args.url);
  if (args.title) patch.title = args.title;

  let to: Target | null = null;
  if (args.next_to) {
    const anchor = known(frames, args.next_to);
    if (anchor.id === frame.id) throw new Error("next_to can't be the frame itself");
    to = { anchor: anchor.id, side: side(args.side) };
  }
  if (!Object.keys(patch).length && !to) throw new Error("nothing to change");
  ctx.doc.transact(() => {
    updateFrame(ctx.doc, frame.id, patch);
    if (to) moveFrame(ctx.doc, frame.id, to);
  });
  return { text: `Updated ${describe(ctx, reread(ctx, frame.id))}.`, frame: frame.id };
}

function closeFrame(ctx: BoardToolContext, frames: Frame[], args: CloseFrameArgs): string {
  const frame = known(frames, args.frame);
  if (frame.id === ctx.self) throw new Error("you can't close your own frame");
  const text = describe(ctx, frame);
  removeFrame(ctx.doc, frame.id);
  return `Closed ${text}.`;
}

function viewFrame(ctx: BoardToolContext, frames: Frame[], args: ViewFrameArgs): BoardToolResult {
  const frame = known(frames, args.frame);
  const lines = [describe(ctx, frame)];
  if (frame.type === "drawing") {
    const elements = visible(readElements(ctx.doc, frame.id));
    lines.push(...describeDrawing(elements));
    return { text: lines.join("\n"), ...(elements.length && { image: frame.id }) };
  }
  if (frame.type === "file") {
    for (const entry of frame.files ?? []) lines.push(`  list: ${describeEntry(entry)}`);
    const comments = readComments(ctx.doc, frame.id);
    lines.push(
      comments.length
        ? `${count(comments.length, "comment")}, by file and line:`
        : "No comments. People add them from the gutter of the source; you with add_comment.",
    );
    for (const comment of comments) lines.push(...describeComment(ctx, comment));
  }
  return { text: lines.join("\n") };
}

function describeComment(ctx: BoardToolContext, comment: Comment): string[] {
  const { author } = comment;
  const by =
    author.kind === "agent"
      ? `agent ${JSON.stringify(author.name)} [${author.frame}]${author.frame === ctx.self ? " (you)" : ""}`
      : `${JSON.stringify(author.name)} (a person)`;
  const where =
    comment.start === comment.end ? `L${comment.start}` : `L${comment.start}-${comment.end}`;
  const head = `- #${comment.id} ${comment.path} ${where} by ${by}${comment.edited ? ", edited" : ""}${comment.outdated ? " — OUTDATED: these lines changed since; they read:" : ":"}`;
  const indent = (text: string) => text.split("\n").map((line) => `    ${line}`);
  return [
    head,
    ...(comment.outdated ? indent(comment.quote).map((line) => `  >${line}`) : []),
    ...indent(comment.body),
  ];
}

function commentOn(
  ctx: BoardToolContext,
  self: Frame,
  frames: Frame[],
  args: AddCommentArgs,
): BoardToolResult {
  const frame = known(frames, args.frame);
  if (frame.type !== "file") throw new Error("comments go on file frames");
  const body = commentBody(args.body);
  const range = lineRange(args);
  if (!range) throw new Error("a comment needs start_line");
  if (typeof args.quote !== "string") throw new Error("canvas serve didn't read the lines");
  const comment = addComment(ctx.doc, frame.id, {
    path: filePath(args.path),
    ...range,
    quote: args.quote,
    body,
    author: { kind: "agent", frame: ctx.self, name: self.title },
  });
  const shown = frame.path === comment.path ? "" : ` (the frame shows ${frame.path || "no file"})`;
  return {
    text: `Added comment #${comment.id} on ${comment.path} L${range.start}-${range.end} in [${frame.id}]${shown}.`,
    frame: frame.id,
  };
}

function changeComment(
  ctx: BoardToolContext,
  frames: Frame[],
  args: EditCommentArgs | DeleteCommentArgs,
): BoardToolResult {
  const frame = known(frames, args.frame);
  const comment = knownComment(ctx, frame.id, args.comment);
  if (!mayChange({ kind: "agent" }, comment))
    throw new Error(
      `#${comment.id} is ${JSON.stringify(comment.author.name)}'s: agents only change agents' comments`,
    );
  if ("body" in args) {
    editComment(ctx.doc, frame.id, comment.id, commentBody(args.body));
    return { text: `Edited comment #${comment.id}.`, frame: frame.id };
  }
  removeComment(ctx.doc, frame.id, comment.id);
  return { text: `Deleted comment #${comment.id}.`, frame: frame.id };
}

function draw(ctx: BoardToolContext, frames: Frame[], args: DrawArgs): BoardToolResult {
  const frame = known(frames, args.frame);
  if (frame.type !== "drawing") throw new Error("draw changes drawing frames");
  if (args.delete !== undefined && !Array.isArray(args.delete))
    throw new Error("delete is a list of element ids");
  const { write, added, replaced, removed } = drawChanges(readElements(ctx.doc, frame.id), {
    add: args.elements ? prepared(args.elements) : [],
    remove: (args.delete ?? []).map(String),
    clear: args.clear === true,
  });
  if (!write.length) throw new Error("nothing to draw: give elements, mermaid, delete or clear");
  writeElements(ctx.doc, frame.id, write);
  const done = [
    added && `added ${count(added, "element")}`,
    replaced && `replaced ${count(replaced, "element")}`,
    removed && `removed ${count(removed, "element")}`,
  ].filter(Boolean);
  const ids = write.filter((e) => !e.isDeleted && e.type !== "text").map((e) => e.id);
  return {
    text:
      `In [${frame.id}]: ${done.join(", ")}.` +
      (ids.length ? ` Ids: ${ids.join(", ")}. view_frame shows the result.` : ""),
    frame: frame.id,
  };
}

// ---------------------------------------------------------------------------

/** Elements the host's browser made from the agent's (`drawing-kit.ts`). */
function prepared(value: unknown): DrawingElement[] {
  const ok =
    Array.isArray(value) &&
    value.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof e.id === "string" &&
        typeof e.version === "number",
    );
  if (!ok) throw new Error("the drawing's elements weren't prepared");
  return value as DrawingElement[];
}

function knownComment(ctx: BoardToolContext, frameId: string, id: unknown): Comment {
  const key = String(id ?? "").replace(/^#/, "");
  const comment = readComments(ctx.doc, frameId).find((c) => c.id === key);
  if (!comment) throw new Error(`no comment ${String(id)} in [${frameId}] — view_frame lists them`);
  return comment;
}

function commentBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("a comment needs a body");
  return value.trim();
}

function known(frames: Frame[], id: unknown): Frame {
  // Agents that load tool schemas lazily sometimes call before they have them.
  if (id === undefined) throw new Error("frame is missing: the id of a frame, from view_board");
  const frame = frames.find((f) => f.id === id);
  if (!frame) throw new Error(`no frame ${String(id)} — view_board lists the frame ids`);
  return frame;
}

function side(value: unknown): Side {
  if (value === undefined) return "right";
  if (value === "left" || value === "right" || value === "above" || value === "below") return value;
  throw new Error("side must be one of: right, left, below, above");
}

function filePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("a file frame needs a path");
  return value.trim().replace(/^(\.\/)+/, "");
}

function lineRange(args: { start_line?: number; end_line?: number }): LineRange | undefined {
  if (args.start_line === undefined) return undefined;
  const start = Math.floor(Number(args.start_line));
  if (!(start >= 1)) throw new Error("start_line must be a line number from 1");
  const end = Math.max(start, Math.floor(Number(args.end_line ?? start)) || start);
  return { start, end };
}

/** A list as the agent gave it (`canvas serve` turned content into paths); null for none. */
function fileList(value: unknown): FileEntry[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("files must be a list of entries");
  if (!value.length) return null;
  const entries = value.map((item: FileListEntry): FileEntry => {
    const display = displayPath(item?.display);
    if (typeof item.path !== "string") throw new Error(`list entry ${display} needs a path`);
    const path = filePath(item.path);
    const lines = lineRange(item);
    return lines ? { display, path, lines } : { display, path };
  });
  checkDisplays(entries.map((entry) => entry.display));
  return entries;
}

function describeEntry(entry: FileEntry): string {
  const lines = entry.lines ? ` L${entry.lines.start}-${entry.lines.end}` : "";
  return entry.display === entry.path
    ? `${entry.path}${lines}`
    : `${JSON.stringify(entry.display)} → ${entry.path}${lines}`;
}

function webUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value.trim()))
    throw new Error(
      "a browser frame needs an http(s) URL; an HTML file of the project or a scratch file " +
        "renders in a file frame (type file, path)",
    );
  return value.trim();
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function reread(ctx: BoardToolContext, id: string): Frame {
  return allFrames(ctx.doc).find((f) => f.id === id)!;
}
