/**
 * Where the frame being dragged would land if dropped now — this browser's
 * own drag, so local state, not board state.
 */

import { useSyncExternalStore } from "react";

import type { Box } from "../../shared/layout";

let current: Box | null = null;
const listeners = new Set<() => void>();

export function setSnapPreview(box: Box | null): void {
  if (box === current || (box && current && JSON.stringify(box) === JSON.stringify(current)))
    return;
  current = box;
  for (const listener of listeners) listener();
}

export function useSnapPreview(): Box | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
