/**
 * Where a link sent us inside a frame: lines of a file's source, or a
 * heading of its preview. It is ours only — not board state, not presence —
 * and waits here until the frame's view has the file to show it in.
 */

import { useSyncExternalStore } from "react";

import type { LineRange } from "./board";

export interface Reveal {
  readonly path: string;
  readonly lines?: LineRange;
  readonly heading?: string;
  /** Tells one request from the next, for the same place. */
  readonly seq: number;
}

const pending = new Map<string, Reveal>();
const listeners = new Set<() => void>();
let seq = 0;

const emit = () => listeners.forEach((listener) => listener());

export function requestReveal(frameId: string, reveal: Omit<Reveal, "seq">): void {
  pending.set(frameId, { ...reveal, seq: ++seq });
  emit();
}

/** The view showed it. */
export function revealed(frameId: string, reveal: Reveal): void {
  if (pending.get(frameId)?.seq !== reveal.seq) return;
  pending.delete(frameId);
  emit();
}

/** What waits to be shown in a frame, whatever its file. */
export const pendingReveal = (frameId: string): Reveal | null => pending.get(frameId) ?? null;

/** What waits to be shown in a frame's view of `path`. */
export function useReveal(frameId: string, path: string): Reveal | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => {
      const reveal = pending.get(frameId);
      return reveal?.path === path ? reveal : null;
    },
  );
}
