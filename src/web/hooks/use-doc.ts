/**
 * The board doc's snapshots as React state. The stores are the doc's
 * modules' (`board.ts`, `comments.ts`, `drawing.ts`), which stay without
 * React: the board's authority uses them (`room/authority.ts`).
 */

import { useSyncExternalStore } from "react";
import type * as Y from "yjs";

import { boardStore, type Board, type Frame } from "@/lib/board";
import { commentsStore, type Comment } from "@/lib/comments";
import { drawingStore, type DrawingElement } from "@/lib/drawing";

export function useBoard(doc: Y.Doc): Board {
  const store = boardStore(doc);
  return useSyncExternalStore(store.subscribe, store.get);
}

export const useFrames = (doc: Y.Doc): Frame[] => useBoard(doc).frames;

export function useComments(doc: Y.Doc, frameId: string): Comment[] {
  const store = commentsStore(doc, frameId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useDrawing(doc: Y.Doc, frameId: string): DrawingElement[] {
  const store = drawingStore(doc, frameId);
  return useSyncExternalStore(store.subscribe, store.get);
}
