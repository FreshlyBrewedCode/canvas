/**
 * The board is one Yjs document shared by everyone in the room:
 *
 *   frames            Y.Map<frameId, Y.Map>   position, size, type, settings
 *   prompt:<frameId>  Y.Text                  an agent frame's shared prompt draft
 *   comments:<frameId> Y.Map<id, Comment>     a file frame's comments (`comments.ts`)
 *
 * Agent threads, terminal output and file contents are not in here: they
 * come from the host's machine and are mirrored separately (see `room.ts`).
 */

import { useSyncExternalStore } from "react";
import * as Y from "yjs";

import type { Patch } from "../../shared/layout";
import { clearComments } from "./comments";

export type FrameType = "agent" | "file" | "browser" | "terminal";

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
  readonly title: string;
  /** The agent frame whose agent opened it, if an agent did. */
  readonly origin?: string;
}

export type Frame = FrameBase &
  (
    | { readonly type: "agent"; readonly agent: string }
    | {
        readonly type: "file";
        /** Working-dir-relative; "" until someone picks a file. */
        readonly path: string;
        readonly view?: FileView | null;
        /** Lines to show and highlight (1-based, inclusive); null for none. */
        readonly lines?: LineRange | null;
        /** An agent's list of files for the tree (ADR 0005); null for none. */
        readonly files?: ReadonlyArray<FileEntry> | null;
      }
    | { readonly type: "browser"; readonly url: string }
    | { readonly type: "terminal" }
  );

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** One file of a list: shown in the tree at `display`, reading `path`. */
export interface FileEntry {
  readonly display: string;
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
};

export const framesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("frames");
export const promptText = (doc: Y.Doc, frameId: string) => doc.getText(`prompt:${frameId}`);

/** One stored frame. Boards from before the files frame have `markdown` frames: files now. */
export function readFrame(map: Y.Map<unknown>, id: string): Frame {
  const value = map.toJSON() as Omit<Frame, "id"> | { type: "markdown" };
  return (value.type === "markdown" ? { ...value, type: "file", id } : { ...value, id }) as Frame;
}

/** Every frame, in no particular order. */
export function allFrames(doc: Y.Doc): Frame[] {
  const frames: Frame[] = [];
  framesOf(doc).forEach((map, id) => frames.push(readFrame(map, id)));
  return frames;
}

/**
 * In a stable order, not by `z`: frames stack by their z-index. Reordering
 * them would move a raised frame's DOM node between pointer down and up —
 * which loses the click that raised it, and reloads a browser frame.
 */
function readFrames(doc: Y.Doc): Frame[] {
  return allFrames(doc).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An immutable frames snapshot per doc, rebuilt only when the frames map changes. */
class FramesStore {
  private snapshot: Frame[];
  constructor(private readonly doc: Y.Doc) {
    this.snapshot = readFrames(doc);
    framesOf(doc).observeDeep(() => (this.snapshot = readFrames(doc)));
  }
  subscribe = (onChange: () => void) => {
    framesOf(this.doc).observeDeep(onChange);
    return () => framesOf(this.doc).unobserveDeep(onChange);
  };
  get = () => this.snapshot;
}
const stores = new WeakMap<Y.Doc, FramesStore>();

export function useFrames(doc: Y.Doc): Frame[] {
  let store = stores.get(doc);
  if (!store) stores.set(doc, (store = new FramesStore(doc)));
  return useSyncExternalStore(store.subscribe, store.get);
}

/** A frame to add: any kind, without the id and stacking the board assigns. */
export type NewFrame = Frame extends infer F
  ? F extends Frame
    ? Omit<F, "id" | "z">
    : never
  : never;

/** Add a frame; `patches` move others out of its way in the same change. */
export function addFrame(doc: Y.Doc, frame: NewFrame, patches: ReadonlyArray<Patch> = []): string {
  const id = crypto.randomUUID().slice(0, 8);
  const z = topZ(doc) + 1;
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...frame, z })) map.set(key, value);
    framesOf(doc).set(id, map);
    applyPatches(doc, patches);
  });
  return id;
}

/** Move and resize frames as the layout says, as one change. */
export function applyPatches(doc: Y.Doc, patches: ReadonlyArray<Patch>): void {
  doc.transact(() => {
    for (const { id, ...patch } of patches) updateFrame(doc, id, patch);
  });
}

export function updateFrame(doc: Y.Doc, id: string, patch: Partial<Record<string, unknown>>): void {
  const map = framesOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) map.set(key, value);
  });
}

export function raiseFrame(doc: Y.Doc, id: string): void {
  const map = framesOf(doc).get(id);
  const top = topZ(doc);
  if (map && (map.get("z") as number) < top) map.set("z", top + 1);
}

export function removeFrame(doc: Y.Doc, id: string, patches: ReadonlyArray<Patch> = []): void {
  doc.transact(() => {
    applyPatches(doc, patches);
    framesOf(doc).delete(id);
    promptText(doc, id).delete(0, promptText(doc, id).length);
    clearComments(doc, id);
  });
}

function topZ(doc: Y.Doc): number {
  let top = 0;
  framesOf(doc).forEach((map) => (top = Math.max(top, (map.get("z") as number) ?? 0)));
  return top;
}
