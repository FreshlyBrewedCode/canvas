/**
 * A drag of a frame or a cluster (ADR 0010, decision 5): ours until the drop,
 * nothing of it in the doc. While it goes, the board shows the drop's result —
 * the others make room where it would land — and the dragged frames follow the
 * pointer. Peers see a ghost of it through presence (`DragGhost`).
 */

import { useSyncExternalStore } from "react";

import {
  applyChanges,
  move,
  moveCluster,
  resolve,
  type Box,
  type Change,
  type Point,
  type Target,
  type Tree,
} from "../../shared/layout";
import type { Frame } from "./board";

interface Base {
  /** The pointer, in board coordinates. */
  readonly pointer: Point;
  /** The pointer from the dragged thing's top-left, as it was grabbed. */
  readonly grab: Point;
}
export interface FrameDrag extends Base {
  readonly kind: "frame";
  readonly frame: string;
  /** Where it goes if dropped now; null: back where it was. */
  readonly target: Target | null;
  /** Along its row, in full screen: it keeps its top. */
  readonly along: boolean;
}
export interface ClusterDrag extends Base {
  readonly kind: "cluster";
  readonly cluster: string;
  /** Before which cluster it goes if dropped now (null: last). */
  readonly before: string | null;
}
export type Drag = FrameDrag | ClusterDrag;

/** A peer's drag, as presence: where the dragged frame is, and where it would land. */
export interface DragGhost {
  readonly title: string;
  readonly box: Box;
  readonly landing: Box | null;
}

let current: Drag | null = null;
/** Just dropped: the frames glide to their places, then stop gliding. */
let settling = false;
let settle: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function setDrag(drag: Drag | null) {
  if (!drag && current) {
    settling = true;
    clearTimeout(settle);
    settle = setTimeout(() => {
      settling = false;
      emit();
    }, SETTLE_MS);
  }
  current = drag;
  emit();
}
export const currentDrag = () => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useDrag = () => useSyncExternalStore(subscribe, () => current);
/** Whether frames glide to new places: while a drag makes room, and as a drop settles. */
export const useGliding = () => useSyncExternalStore(subscribe, () => current !== null || settling);

/** How long frames glide into place. */
export const SETTLE_MS = 200;

/** Ids for containers a preview makes up: the same each time, so its result is too. */
const previewIds = () => {
  let n = 0;
  return () => `~preview${++n}`;
};

/** The changes a drop now would make. */
export function dropChanges(tree: Tree, drag: Drag): Change[] {
  if (drag.kind === "cluster") return moveCluster(tree, drag.cluster, drag.before);
  return drag.target ? move(tree, drag.frame, drag.target, previewIds()) : [];
}

/**
 * The board as a drop now would leave it, the dragged frames at the pointer:
 * frames with their rects, and where the dragged frame or cluster lands.
 */
export function preview(
  tree: Tree,
  frames: ReadonlyArray<Frame>,
  drag: Drag,
): { frames: Frame[]; landing: Box | null } {
  const layout = resolve(applyChanges(tree, dropChanges(tree, drag)));
  const origin = { x: drag.pointer.x - drag.grab.x, y: drag.pointer.y - drag.grab.y };
  let landing: Box | null = null;
  let from: Point = { x: 0, y: 0 };
  const dragged = (f: Frame) =>
    drag.kind === "frame" ? f.id === drag.frame : f.cluster === drag.cluster;
  if (drag.kind === "frame") {
    const frame = frames.find((f) => f.id === drag.frame);
    const at = layout.frames.get(drag.frame)?.frame;
    if (frame) from = frame;
    if (at && drag.target) landing = { x: at.x, y: at.y, w: at.w, h: at.h };
  } else {
    const was = frames.filter((f) => f.cluster === drag.cluster);
    from = { x: Math.min(...was.map((f) => f.x)), y: Math.min(...was.map((f) => f.y)) };
    landing = layout.clusters.find((k) => k.id === drag.cluster)?.box ?? null;
  }
  return {
    landing,
    frames: frames.map((f) => {
      if (dragged(f))
        return {
          ...f,
          x: origin.x + f.x - from.x,
          y: drag.kind === "frame" && drag.along ? f.y : origin.y + f.y - from.y,
        };
      const at = layout.frames.get(f.id);
      if (!at) return f;
      const { x, y, w, h } = at.frame;
      return { ...f, x, y, w, h, row: at.row.id, column: at.column.id, cluster: at.cluster.id };
    }),
  };
}
