/**
 * The board is one Yjs document shared by everyone in the room:
 *
 *   frames            Y.Map<frameId, Y.Map>   type, settings, and its place in the tree
 *   layout            Y.Map<id, Y.Map>        clusters, rows and columns (ADR 0010)
 *   prompt:<frameId>  Y.Text                  an agent frame's shared prompt draft
 *   comments:<frameId> Y.Map<id, Comment>     a file frame's comments (`comments.ts`)
 *   drawing:<frameId>  Y.Map<id, element>     a drawing frame's elements (`drawing.ts`)
 *
 * Agent threads, terminal output and file contents are not in here: they
 * come from the host's machine and are mirrored separately (see `room.ts`).
 * Agent, file and terminal frames say where theirs are (ADR 0013): a
 * `runtime`, a file frame's `root`, a terminal's `pty`. Absent is the
 * board's own runtime, its working dir and the frame's own id: nothing
 * writes these defaults, so boards from before need no migration.
 *
 * Where frames are is structure — a frame's column, its row, its cluster —
 * and their rects are derived from it (`resolve`, `shared/layout.ts`), the
 * same on every peer. Frames change place by the layout's operations, one
 * transaction each. The host tidies up (`tidy`): boards from before the tree
 * are migrated, what concurrency leaves is repaired, empty containers go.
 */

import { useSyncExternalStore } from "react";
import * as Y from "yjs";

import {
  applyChanges,
  insert,
  migrate,
  move,
  prune,
  repair,
  resize,
  resolve,
  type Change,
  type Container,
  type Layout,
  type Leaf,
  type Rect,
  type Size,
  type Target,
  type Tree,
} from "../../shared/layout";
import { isRuntimeId, reach, type Address, type Reach } from "../../shared/address";
import type { AgentSetting } from "../../shared/protocol";
import { isSessionId } from "../../shared/sessions";
import { clearComments } from "./comments";
import { clearDrawing } from "./drawing";

export type FrameType = "agent" | "file" | "browser" | "terminal" | "drawing";

/** How a file frame shows its file; null is the file's default (preview for markdown). */
export type FileView = "preview" | "source";

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
export const isHtml = (path: string) => /\.html?$/i.test(path);
/** Files with a rendered view, which they open in. */
export const hasPreview = (path: string) => isMarkdown(path) || isHtml(path);

/** How a file frame shows its file now. Lines only show in the source: a range asked for means it. */
export function fileView(frame: {
  readonly path: string;
  readonly view?: FileView | null;
  readonly lines?: LineRange | null;
}): FileView {
  return frame.view ?? (hasPreview(frame.path) && !frame.lines ? "preview" : "source");
}

interface FrameBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  /** Where it is (ADR 0010): x, y, w and h are derived from these. */
  readonly cluster: string;
  readonly row: string;
  readonly column: string;
  /** A height of its own, kept in full screen (terminals). */
  readonly height?: number;
  readonly title: string;
  /** The agent frame whose agent opened it, if an agent did. */
  readonly origin?: string;
}

export type Frame = FrameBase &
  (
    | {
        readonly type: "agent";
        /** The runtime its sessions are on (ADR 0013); absent: the board's own. */
        readonly runtime?: string;
        /** A kind of agent its runtime offers. */
        readonly agent: string;
        /** The session it shows (ADR 0012); without one, the session with the frame's id. */
        readonly session?: string;
        /**
         * The settings a new conversation starts with, until its first prompt
         * (decision 4): they only matter while the session it shows has no record.
         */
        readonly settings?: ReadonlyArray<AgentSetting>;
      }
    | {
        readonly type: "file";
        /** The runtime and root of its file (ADR 0013); absent: the board's own, its working dir. */
        readonly runtime?: string;
        readonly root?: string;
        /** Root-relative; "" until someone picks a file. */
        readonly path: string;
        readonly view?: FileView | null;
        /** Lines to show and highlight (1-based, inclusive); null for none. */
        readonly lines?: LineRange | null;
        /** An agent's list of files for the tree (ADR 0005); null for none. */
        readonly files?: ReadonlyArray<FileEntry> | null;
      }
    | { readonly type: "browser"; readonly url: string }
    | {
        readonly type: "terminal";
        /** The runtime its PTY is on (ADR 0013); absent: the board's own. */
        readonly runtime?: string;
        /** The PTY it shows; absent: the one with the frame's id (`shownPty`). */
        readonly pty?: string;
      }
    /** An Excalidraw drawing; its elements are in `drawing:<id>` (ADR 0009). */
    | { readonly type: "drawing" }
  );

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** One file of a list: shown in the tree at `display`, reading `path`. */
export interface FileEntry {
  readonly display: string;
  /** The runtime and root of its file (ADR 0013); absent: the board's own, its working dir. */
  readonly runtime?: string;
  readonly root?: string;
  /** A file of the shared set, or a scratch file (`canvas:scratch/…`). */
  readonly path: string;
  /** Lines to open it at, badged in the tree. */
  readonly lines?: LineRange | null;
}

export const DEFAULT_SIZE: Record<FrameType, { w: number; h: number }> = {
  agent: { w: 460, h: 620 },
  file: { w: 720, h: 560 },
  browser: { w: 720, h: 520 },
  terminal: { w: 640, h: 400 },
  // Excalidraw's full toolbars want 500 px of height on screen.
  drawing: { w: 960, h: 640 },
};

export type AgentFrame = Extract<Frame, { type: "agent" }>;

/**
 * The agent session a frame shows (ADR 0012): the one it names, else the one
 * with the frame's id — its first conversation, so boards from before need no
 * migration. A name that is no session id (guests write the doc) is ignored.
 */
export const shownSession = (frame: AgentFrame): string =>
  isSessionId(frame.session) ? frame.session : frame.id;

/**
 * A new conversation in an agent frame (decision 4): a fresh id, and the
 * settings it starts with. Nothing runs, and `canvas serve` hears of it only
 * with its first prompt. The new session's id.
 */
export function newConversation(
  doc: Y.Doc,
  frameId: string,
  settings: ReadonlyArray<AgentSetting> | undefined,
): string {
  const id = crypto.randomUUID();
  showConversation(doc, frameId, id, settings);
  return id;
}

/**
 * An agent frame shows another session (decision 1): shared, like everything
 * a frame shows. Starting settings go with it, or (none given) go: those of
 * a conversation never prompted are only good for that one.
 */
export function showConversation(
  doc: Y.Doc,
  frameId: string,
  sessionId: string,
  settings?: ReadonlyArray<AgentSetting>,
): void {
  const map = framesOf(doc).get(frameId);
  if (!map || map.get("type") !== "agent" || !isSessionId(sessionId)) return;
  doc.transact(() => {
    map.set("session", sessionId);
    if (settings?.length)
      map.set(
        "settings",
        settings.map((s) => ({ ...s })),
      );
    else map.delete("settings");
  });
}

export type TerminalFrame = Extract<Frame, { type: "terminal" }>;

/**
 * The PTY a terminal frame shows (ADR 0013, decision 4): the one it names,
 * else the one with the frame's id, as before. A name that is no id is
 * ignored, as `shownSession` ignores a bad session.
 */
export const shownPty = (frame: TerminalFrame): string =>
  isRuntimeId(frame.pty) ? frame.pty : frame.id;

/**
 * Where a frame's agent, file or terminal is, for whoever is connected to
 * the runtime `own` (`shared/address.ts`). Browser and drawing frames are on
 * no runtime: always here.
 */
export function frameReach(frame: Frame, own: string | null | undefined): Reach {
  switch (frame.type) {
    case "agent":
    case "terminal":
      return reach({ runtime: frame.runtime }, own);
    case "file":
      return reach({ runtime: frame.runtime, root: frame.root }, own);
    default:
      return "own";
  }
}

export const framesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("frames");
export const layoutOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("layout");
export const promptText = (doc: Y.Doc, frameId: string) => doc.getText(`prompt:${frameId}`);

/** A frame's place in the tree: the fields of a stored frame the layout owns. */
const PLACE = ["parent", "pos", "cluster", "weight", "height"] as const;

/**
 * One stored frame, without where it is. Boards from before the files frame
 * have `markdown` frames: files now.
 */
export function readFrame(map: Y.Map<unknown>, id: string): Frame {
  const value = map.toJSON() as Omit<Frame, "id"> | { type: "markdown" };
  return (value.type === "markdown" ? { ...value, type: "file", id } : { ...value, id }) as Frame;
}

/** The layout's tree, as the doc has it. */
export function readTree(doc: Y.Doc): Tree {
  const containers: Container[] = [];
  layoutOf(doc).forEach((map, id) => containers.push({ ...(map.toJSON() as Container), id }));
  const frames: Leaf[] = [];
  framesOf(doc).forEach((map, id) => {
    const leaf: Record<string, unknown> = { id };
    for (const key of PLACE) if (map.has(key)) leaf[key] = map.get(key);
    frames.push(leaf as unknown as Leaf);
  });
  return { containers, frames };
}

export interface Board {
  /** In a stable order, not by `z` (see `readBoard`). */
  readonly frames: Frame[];
  readonly layout: Layout;
  readonly tree: Tree;
}

/**
 * Every frame with its rect. In a stable order, not by `z`: frames stack by
 * their z-index. Reordering them would move a raised frame's DOM node between
 * pointer down and up — which loses the click that raised it, and reloads a
 * browser frame.
 */
function readBoard(doc: Y.Doc): Board {
  const tree = readTree(doc);
  const layout = resolve(tree);
  const frames: Frame[] = [];
  framesOf(doc).forEach((map, id) => {
    const at = layout.frames.get(id);
    if (!at) return;
    const { x, y, w, h } = at.frame;
    const frame = { ...readFrame(map, id), x, y, w, h };
    frames.push({ ...frame, cluster: at.cluster.id, row: at.row.id, column: at.column.id });
  });
  frames.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { frames, layout, tree };
}

/** Every frame, as the doc has it now. */
export const allFrames = (doc: Y.Doc): Frame[] => readBoard(doc).frames;
/** The board's layout, as the doc has it now. */
export const boardLayout = (doc: Y.Doc): Layout => readBoard(doc).layout;

/** An immutable snapshot per doc, rebuilt when frames or the layout change. */
class BoardStore {
  private snapshot: Board | null = null;
  constructor(private readonly doc: Y.Doc) {
    this.subscribe(() => (this.snapshot = null));
  }
  subscribe = (onChange: () => void) => {
    framesOf(this.doc).observeDeep(onChange);
    layoutOf(this.doc).observeDeep(onChange);
    return () => {
      framesOf(this.doc).unobserveDeep(onChange);
      layoutOf(this.doc).unobserveDeep(onChange);
    };
  };
  get = () => (this.snapshot ??= readBoard(this.doc));
}
const stores = new WeakMap<Y.Doc, BoardStore>();

export function useBoard(doc: Y.Doc): Board {
  let store = stores.get(doc);
  if (!store) stores.set(doc, (store = new BoardStore(doc)));
  return useSyncExternalStore(store.subscribe, store.get);
}
export const useFrames = (doc: Y.Doc): Frame[] => useBoard(doc).frames;

/** A frame to add: any kind, without the id and stacking the board assigns. */
export type NewFrame = Frame extends infer F
  ? F extends Frame
    ? Omit<F, "id" | "z" | "x" | "y" | "w" | "h" | "cluster" | "row" | "column" | "height">
    : never
  : never;

/** A new frame of a type, named after how many of its type the board has. */
export function newFrame(
  type: FrameType,
  frames: ReadonlyArray<Frame>,
  extra: Record<string, string> = {},
): NewFrame {
  const count = frames.filter((f) => f.type === type).length + 1;
  switch (type) {
    case "agent":
      // The frame asks which agent to run.
      return { type, title: `agent-${count}`, agent: "" };
    case "file":
      // The frame opens with its tree, to pick a file.
      return { type, title: `files-${count}`, path: "" };
    case "browser":
      return { type, title: `preview-${count}`, url: extra.url ?? "https://example.com" };
    case "drawing":
      return { type, title: `drawing-${count}` };
    case "terminal":
      return { type, title: `shell-${count}` };
  }
}

/**
 * Add a frame at `target` (a new cluster at the end by default): `size` is
 * its column's width, and its row's height if it starts one.
 */
export function addFrame(
  doc: Y.Doc,
  frame: NewFrame,
  target: Target = { before: null },
  size: Size = DEFAULT_SIZE[frame.type],
): string {
  const id = crypto.randomUUID().slice(0, 8);
  const z = topZ(doc) + 1;
  const place = insert(readTree(doc), id, target, size);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...frame, z })) map.set(key, value);
    framesOf(doc).set(id, map);
    applyLayout(doc, place);
  });
  return id;
}

/**
 * Our own hands' changes of the layout (a drop, a resize, a frame added or
 * closed from the UI): the view isn't anchored against them (`use-anchor.ts`).
 */
export const OWN = Symbol("own");
export const own = <T>(doc: Y.Doc, change: () => T): T => {
  let result!: T;
  doc.transact(() => (result = change()), OWN);
  return result;
};

/** Move a frame to `target`, as one change. */
export function moveFrame(doc: Y.Doc, id: string, target: Target): void {
  applyLayout(doc, move(readTree(doc), id, target));
}

/** A column's width, a row's height, or a frame's own height. */
export function resizeLayout(doc: Y.Doc, what: Parameters<typeof resize>[0]): void {
  applyLayout(doc, resize(what));
}

/** Apply the layout's changes as one change of the doc. */
export function applyLayout(doc: Y.Doc, changes: ReadonlyArray<Change>): void {
  doc.transact(() => {
    for (const change of changes) {
      if (change.kind === "remove") {
        layoutOf(doc).delete(change.id);
        continue;
      }
      const maps = change.kind === "frame" ? framesOf(doc) : layoutOf(doc);
      let map = maps.get(change.id);
      if (!map) {
        // A frame is only placed if it is there (a concurrent close wins).
        if (change.kind === "frame") continue;
        maps.set(change.id, (map = new Y.Map()));
      }
      for (const [key, value] of Object.entries(change.set)) map.set(key, value);
      if (change.kind === "frame") for (const key of change.unset ?? []) map.delete(key);
    }
  });
}

/** A terminal's height, as a share of the host's screen, until someone sets another. */
export const TERMINAL_SHARE = 0.5;

/**
 * The host keeps the tree tidy: frames from before it are read into it by
 * where they were, what lost its place gets real containers where it shows,
 * and empty containers go. Terminals without a height get their share of the
 * host's `screen` height: the host's terminal sizes the PTY for everyone, so
 * everyone shows it that tall (ADR 0010, decision 7). False if there was
 * nothing to do.
 */
export function tidy(doc: Y.Doc, { screen }: { readonly screen?: number } = {}): boolean {
  let tree = readTree(doc);
  const old: Array<Rect> = [];
  framesOf(doc).forEach((map, id) => {
    const [x, y, w, h] = (["x", "y", "w", "h"] as const).map((k) => map.get(k));
    if (map.has("parent") || typeof x !== "number" || typeof y !== "number") return;
    old.push({ id, x, y, w: typeof w === "number" ? w : 640, h: typeof h === "number" ? h : 480 });
  });
  const changes: Change[] = [];
  for (const step of [(t: Tree) => migrate(t, old), repair, prune]) {
    const next = step(tree);
    changes.push(...next);
    tree = applyChanges(tree, next);
  }
  if (screen)
    framesOf(doc).forEach((map, id) => {
      if (map.get("type") === "terminal" && !map.has("height"))
        changes.push(...resize({ frame: id, height: screen * TERMINAL_SHARE }));
    });
  if (!changes.length) return false;
  applyLayout(doc, changes);
  return true;
}

/** Change a frame's fields; `undefined` removes one. */
export function updateFrame(doc: Y.Doc, id: string, patch: Partial<Record<string, unknown>>): void {
  const map = framesOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) map.delete(key);
      else map.set(key, value);
  });
}

/**
 * The fields that put a file frame at `address` (`updateFrame`): written
 * only when not the own runtime or the working dir, else removed (ADR 0013).
 * `address` is as writers write it (`canonical`).
 */
export const atAddress = (address: Address) => ({
  runtime: address.runtime,
  root: address.root,
});

export function raiseFrame(doc: Y.Doc, id: string): void {
  const map = framesOf(doc).get(id);
  const top = topZ(doc);
  if (map && (map.get("z") as number) < top) map.set("z", top + 1);
}

/** Remove a frame; the containers it leaves empty go when the host tidies up. */
export function removeFrame(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    framesOf(doc).delete(id);
    promptText(doc, id).delete(0, promptText(doc, id).length);
    clearComments(doc, id);
    clearDrawing(doc, id);
  });
}

function topZ(doc: Y.Doc): number {
  let top = 0;
  framesOf(doc).forEach((map) => (top = Math.max(top, (map.get("z") as number) ?? 0)));
  return top;
}
