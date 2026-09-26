/**
 * Where the frame being dragged would land if dropped now — this browser's
 * own drag, so local state, not board state. Dropped between two frames or
 * rows it goes in between, and the preview is the line along that gap
 * (`insertion` in `shared/layout.ts`) rather than the landing box, which
 * would sit on top of the frames about to make room.
 */

import { useSyncExternalStore } from "react";

import type { Box } from "../../shared/layout";

export type SnapPreview =
  | { readonly kind: "place"; readonly box: Box }
  | { readonly kind: "insert"; readonly line: Box };

let current: SnapPreview | null = null;
const listeners = new Set<() => void>();

export function setSnapPreview(preview: SnapPreview | null): void {
  if (
    preview === current ||
    (preview && current && JSON.stringify(preview) === JSON.stringify(current))
  )
    return;
  current = preview;
  for (const listener of listeners) listener();
}

export function useSnapPreview(): SnapPreview | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
