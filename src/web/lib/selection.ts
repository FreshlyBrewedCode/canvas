/**
 * Mirroring text selections in rendered content: agent threads and markdown
 * previews. A selection is published as (block key, character offset) pairs
 * — every peer renders the same keys (`thread.ts`, the preview's source
 * lines), so the pair resolves back to the same text anywhere, whatever the
 * other person's zoom, frame size or scroll.
 *
 * Markup: a root carries `data-sel-root=<frameId>` (and `data-sel-path` for a
 * file), each selectable block `data-sel-key=<key>`.
 */

import type { TextSelection } from "./room";

type Anchor = TextSelection["anchor"];

function locate(
  node: Node,
  offset: number,
): { frameId: string; path: string | undefined; anchor: Anchor } | null {
  const element = node instanceof Element ? node : node.parentElement;
  const keyed = element?.closest<HTMLElement>("[data-sel-key]");
  const root = keyed?.closest<HTMLElement>("[data-sel-root]");
  if (!keyed || !root) return null;
  const range = document.createRange();
  range.setStart(keyed, 0);
  range.setEnd(node, offset);
  return {
    frameId: root.dataset.selRoot!,
    path: root.dataset.selPath,
    anchor: { key: keyed.dataset.selKey!, offset: range.toString().length },
  };
}

/** The current document selection, if it is a non-empty range inside one root. */
export function readSelection(): TextSelection | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode)
    return null;
  const anchor = locate(selection.anchorNode, selection.anchorOffset);
  const focus = locate(selection.focusNode, selection.focusOffset);
  if (!anchor || !focus || anchor.frameId !== focus.frameId) return null;
  return {
    kind: "text",
    frameId: anchor.frameId,
    ...(anchor.path !== undefined && { path: anchor.path }),
    anchor: anchor.anchor,
    focus: focus.anchor,
  };
}

function resolve(
  root: HTMLElement,
  { key, offset }: Anchor,
): { node: Node; offset: number } | null {
  const keyed = root.querySelector<HTMLElement>(`[data-sel-key="${CSS.escape(key)}"]`);
  if (!keyed) return null;
  const walker = document.createTreeWalker(keyed, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.length) return { node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : { node: keyed, offset: 0 };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a remote selection sits inside `root`, in `root`'s own unscaled
 * coordinates (the board is CSS-scaled, client rects are not).
 */
export function selectionBoxes(root: HTMLElement, selection: TextSelection): Box[] {
  const a = resolve(root, selection.anchor);
  const b = resolve(root, selection.focus);
  if (!a || !b) return [];
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  if (range.collapsed) {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  const origin = root.getBoundingClientRect();
  const scale = origin.width / root.offsetWidth || 1;
  return [...range.getClientRects()]
    .filter((rect) => rect.width > 0.5)
    .map((rect) => ({
      left: (rect.left - origin.left) / scale,
      top: (rect.top - origin.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    }));
}
