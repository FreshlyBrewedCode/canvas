/**
 * The board is one Yjs document shared by everyone in the room:
 *
 *   frames            Y.Map<frameId, Y.Map>   position, size, type, settings
 *   prompt:<frameId>  Y.Text                  an agent frame's shared prompt draft
 *
 * Agent threads, terminal output and file contents are not in here: they
 * come from the host's machine and are mirrored separately (see `room.ts`).
 */

import { useSyncExternalStore } from "react";
import * as Y from "yjs";

export type FrameType = "agent" | "markdown" | "browser" | "terminal";

interface FrameBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly title: string;
}

export type Frame = FrameBase &
  (
    | { readonly type: "agent"; readonly agent: string }
    | { readonly type: "markdown"; readonly path: string }
    | { readonly type: "browser"; readonly url: string }
    | { readonly type: "terminal" }
  );

export const DEFAULT_SIZE: Record<FrameType, { w: number; h: number }> = {
  agent: { w: 460, h: 620 },
  markdown: { w: 480, h: 560 },
  browser: { w: 720, h: 520 },
  terminal: { w: 640, h: 400 },
};

export const framesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("frames");
export const promptText = (doc: Y.Doc, frameId: string) => doc.getText(`prompt:${frameId}`);

function readFrames(doc: Y.Doc): Frame[] {
  const frames: Frame[] = [];
  framesOf(doc).forEach((map, id) => {
    const value = map.toJSON() as Omit<Frame, "id">;
    frames.push({ ...value, id } as Frame);
  });
  return frames.sort((a, b) => a.z - b.z);
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

export function addFrame(doc: Y.Doc, frame: Omit<Frame, "id" | "z">): string {
  const id = crypto.randomUUID().slice(0, 8);
  const z = topZ(doc) + 1;
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...frame, z })) map.set(key, value);
    framesOf(doc).set(id, map);
  });
  return id;
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

export function removeFrame(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    framesOf(doc).delete(id);
    promptText(doc, id).delete(0, promptText(doc, id).length);
  });
}

function topZ(doc: Y.Doc): number {
  let top = 0;
  framesOf(doc).forEach((map) => (top = Math.max(top, (map.get("z") as number) ?? 0)));
  return top;
}
