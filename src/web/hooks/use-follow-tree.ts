import type { FileTree } from "@pierre/trees";
import { useEffect, useRef } from "react";

import { useRoom } from "@/lib/room-context";
import type { Room } from "@/lib/room";

/** The folders open, of those showing. */
export function expandedOf(model: FileTree): string[] {
  return model
    .getVisibleRows(0, model.getVisibleCount())
    .filter((row) => row.kind === "directory" && row.isExpanded)
    .map((row) => row.path);
}

/** The tree's scroller, in its shadow root once it has rendered. */
function scrollerOf(model: FileTree): HTMLElement | null {
  const root = model.getFileTreeContainer()?.shadowRoot;
  return root?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]") ?? null;
}

/** Everything a person does to a tree: presses, keys (search, arrows), wheel, touch. */
const OWN_INPUT = ["pointerdown", "keydown", "wheel", "touchmove"] as const;

/**
 * A file tree follows its frame's occupant (`focus.ts`): as the occupant we
 * publish its open folders, search and scroll; following someone, we open
 * and close ours to match, search what they search and scroll where they
 * are. Doing anything in the tree ourselves stops following, for us only.
 *
 * `of` names the tree (`TreeView.of`): only the same tree follows. Nothing
 * here re-renders the tree: a re-render between pointer down and up loses
 * the click (see `FileTree`).
 */
export function useFollowTree(model: FileTree, frameId: string | undefined, of: string) {
  const room = useRoom();
  useEffect(() => {
    if (!frameId) return;
    let published = 0;
    let applied = 0;
    /** The occupant's tree we last applied: their presence changes with every pointer move. */
    let last = "";
    let scroller: HTMLElement | null = null;
    let host: HTMLElement | undefined;

    const publish = () => {
      if (!room.frameFocus(frameId).mine) return;
      cancelAnimationFrame(published);
      published = requestAnimationFrame(() =>
        room.publishTree(frameId, {
          of,
          expanded: expandedOf(model),
          search: model.isSearchOpen() ? model.getSearchValue() : null,
          top: Math.round(scroller?.scrollTop ?? 0),
        }),
      );
    };

    const apply = () => {
      const tree = room.occupantTree(frameId);
      if (!room.frameFocus(frameId).following || !tree || tree.of !== of) return;
      last = JSON.stringify(tree);
      const search = model.isSearchOpen() ? model.getSearchValue() : null;
      if (search !== tree.search) model.setSearch(tree.search);
      const want = new Set(tree.expanded);
      for (const dir of expandedOf(model)) {
        const handle = model.getItem(dir);
        if (!want.has(dir) && handle && "collapse" in handle) handle.collapse();
      }
      for (const dir of tree.expanded) {
        const handle = model.getItem(dir);
        if (handle && "expand" in handle && !handle.isExpanded()) handle.expand();
      }
      // Once the rows are laid out for the folders just opened.
      cancelAnimationFrame(applied);
      applied = requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = tree.top;
      });
    };

    const detach = () => {
      if (room.frameFocus(frameId).following) room.detach(frameId);
    };

    // The tree renders its scroller after it mounts: attach once it's there.
    let wait = 0;
    const attach = () => {
      scroller = scrollerOf(model);
      host = model.getFileTreeContainer();
      if (!scroller || !host) {
        wait = requestAnimationFrame(attach);
        return;
      }
      scroller.addEventListener("scroll", publish, { passive: true });
      for (const type of OWN_INPUT)
        host.addEventListener(type, detach, { capture: true, passive: true });
      publish();
      apply();
    };
    attach();

    let wasMine = room.frameFocus(frameId).mine;
    const offFocus = room.subscribe("focus", () => {
      const { mine } = room.frameFocus(frameId);
      if (mine && !wasMine) publish();
      wasMine = mine;
      if (JSON.stringify(room.occupantTree(frameId)) !== last) apply();
    });
    // Folders, search, the files themselves: publish, or re-apply ours.
    const offModel = model.subscribe(() => (room.frameFocus(frameId).mine ? publish() : apply()));

    return () => {
      offFocus();
      offModel();
      cancelAnimationFrame(wait);
      cancelAnimationFrame(published);
      cancelAnimationFrame(applied);
      scroller?.removeEventListener("scroll", publish);
      for (const type of OWN_INPUT) host?.removeEventListener(type, detach, { capture: true });
    };
  }, [room, model, frameId, of]);
}

/** How a file frame has its tree panel: which tree, or null for closed, and its width. */
export interface TreePanel {
  readonly panel: string | null;
  readonly size: number;
}

/**
 * A file frame's tree panel follows its occupant too: open or closed, which
 * tree, how wide. `current` is ours; `apply` makes it the occupant's.
 * Returns what detaches us: pressing the panel's controls ourselves.
 */
export function useFollowTreePanel(
  frameId: string,
  current: TreePanel,
  apply: (panel: TreePanel) => void,
): () => void {
  const room = useRoom();
  const latest = useRef({ current, apply });
  useEffect(() => {
    latest.current = { current, apply };
  });

  // Ours changed: publish it, if the frame is ours.
  const { panel, size } = current;
  useEffect(() => {
    const raf = requestAnimationFrame(() => room.publishTree(frameId, { panel, size }));
    return () => cancelAnimationFrame(raf);
  }, [room, frameId, panel, size]);

  useEffect(() => {
    let wasMine = false;
    let last: TreePanel | null = null;
    const sync = () => {
      const { mine, following } = room.frameFocus(frameId);
      if (mine && !wasMine) room.publishTree(frameId, latest.current.current);
      wasMine = mine;
      const tree = room.occupantTree(frameId);
      if (!following) last = null;
      if (!following || !tree || (last?.panel === tree.panel && last.size === tree.size)) return;
      last = { panel: tree.panel, size: tree.size };
      latest.current.apply(last);
    };
    sync();
    return room.subscribe("focus", sync);
  }, [room, frameId]);

  return () => detachFrom(room, frameId);
}

function detachFrom(room: Room, frameId: string) {
  if (room.frameFocus(frameId).following) room.detach(frameId);
}
