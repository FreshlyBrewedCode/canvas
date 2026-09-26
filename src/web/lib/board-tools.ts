/**
 * The board tools (`shared/board-tools.ts`) run here, in the host's browser,
 * against the board doc — the same doc people edit, so an agent's changes
 * travel to everyone like anyone else's. `canvas serve` relays each call from
 * the agent and has already checked any file path against the shared set.
 *
 * An agent has the board powers of an `edit` guest: it opens, changes and
 * closes frames, and nothing it does here runs on the machine by itself (a
 * new agent frame gets only a draft; a terminal frame is an idle shell).
 * Results are plain text for the model, and people read them in the thread.
 */

import type * as Y from "yjs";

import type {
  CloseFrameArgs,
  FileListEntry,
  OpenFrameArgs,
  UpdateFrameArgs,
  ViewBoardArgs,
} from "../../shared/board-tools";
import {
  clusters,
  moveFrame,
  lift,
  placeNear,
  placeNew,
  type Cluster,
  type Patch,
  type Side,
} from "../../shared/layout";
import type { AgentInfo } from "../../shared/protocol";
import {
  addFrame,
  allFrames,
  applyPatches,
  DEFAULT_SIZE,
  promptText,
  removeFrame,
  updateFrame,
  type FileEntry,
  type Frame,
  type LineRange,
  type NewFrame,
} from "./board";
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
    case "open_frame":
      return openFrame(ctx, frames, input as unknown as OpenFrameArgs);
    case "update_frame":
      return changeFrame(ctx, frames, input as unknown as UpdateFrameArgs);
    case "close_frame":
      return { text: closeFrame(ctx, frames, input as unknown as CloseFrameArgs) };
    default:
      throw new Error(`no tool ${name}`);
  }
}

// ---------------------------------------------------------------------------

function viewBoard(ctx: BoardToolContext, frames: Frame[], args: ViewBoardArgs): string {
  const all = clusters(frames);
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

function rows(ctx: BoardToolContext, cluster: Cluster<Frame>) {
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
      break;
    case "browser":
      parts.push("browser", JSON.stringify(frame.title), frame.url);
      break;
    case "terminal":
      parts.push("terminal", JSON.stringify(frame.title));
      break;
  }
  if (frame.id === ctx.self) parts.push("(you)");
  else if (frame.origin === ctx.self) parts.push("(opened by you)");
  else if (frame.origin) parts.push(`(opened by agent [${frame.origin}])`);
  return parts.join(" ");
}

/** A new frame without its geometry, for each kind of frame. */
type Content = NewFrame extends infer F
  ? F extends NewFrame
    ? Omit<F, "x" | "y" | "w" | "h">
    : never
  : never;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------

function openFrame(ctx: BoardToolContext, frames: Frame[], args: OpenFrameArgs): BoardToolResult {
  const numbered = (prefix: string, type: Frame["type"]) =>
    `${prefix}-${frames.filter((f) => f.type === type).length + 1}`;
  let frame: Content;
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
    case "agent": {
      const kinds = ctx.agents.map((a) => a.kind);
      if (!args.agent || !kinds.includes(args.agent))
        throw new Error(`agent must be one of: ${kinds.join(", ") || "(none installed)"}`);
      frame = { type: "agent", agent: args.agent, title: numbered(args.agent, "agent") };
      break;
    }
    default:
      throw new Error("type must be one of: file, browser, terminal, agent");
  }
  const size = DEFAULT_SIZE[args.type];
  const { rect, patches } = args.next_to
    ? placeNew(frames, { anchor: known(frames, args.next_to).id, side: side(args.side) }, size)
    : placeNear(frames, ctx.self, size);
  const id = addFrame(
    ctx.doc,
    { ...frame, ...rect, ...(args.title && { title: args.title }), origin: ctx.self } as NewFrame,
    patches,
  );
  if (args.type === "agent" && args.draft) promptText(ctx.doc, id).insert(0, args.draft);
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
    args.path !== undefined || args.start_line !== undefined || args.view || args.files;
  if (wantsFile && frame.type !== "file")
    throw new Error("path, lines, view and files only apply to file frames");
  if (args.url !== undefined && frame.type !== "browser")
    throw new Error("url only applies to browser frames");

  if (frame.type === "file") {
    if (args.path !== undefined) {
      const path = filePath(args.path);
      const defaultTitle = frame.title === basename(frame.path) || /^files-\d+$/.test(frame.title);
      Object.assign(patch, { path, view: null, lines: lineRange(args) ?? null });
      if (defaultTitle) patch.title = basename(path);
    } else if (args.start_line !== undefined) patch.lines = lineRange(args);
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

  let moves: Patch[] = [];
  if (args.next_to) {
    const anchor = known(frames, args.next_to);
    if (anchor.id === frame.id) throw new Error("next_to can't be the frame itself");
    moves = moveFrame(frames, frame.id, { anchor: anchor.id, side: side(args.side) });
  }
  if (!Object.keys(patch).length && !moves.length) throw new Error("nothing to change");
  ctx.doc.transact(() => {
    updateFrame(ctx.doc, frame.id, patch);
    applyPatches(ctx.doc, moves);
  });
  return { text: `Updated ${describe(ctx, reread(ctx, frame.id))}.`, frame: frame.id };
}

function closeFrame(ctx: BoardToolContext, frames: Frame[], args: CloseFrameArgs): string {
  const frame = known(frames, args.frame);
  if (frame.id === ctx.self) throw new Error("you can't close your own frame");
  const text = describe(ctx, frame);
  removeFrame(ctx.doc, frame.id, lift(frames, frame.id));
  return `Closed ${text}.`;
}

// ---------------------------------------------------------------------------

function known(frames: Frame[], id: unknown): Frame {
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
