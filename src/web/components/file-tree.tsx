import { FileTree as TreeView, useFileTree } from "@pierre/trees/react";
import { memo, useEffect, useRef } from "react";

import { listOrder } from "@/lib/file-list";

/** Every directory above a path, as the tree names them (`a/`, `a/b/`). */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`);
}

/** The folders to open: all of a list's, else those above the file shown. */
function expandedFor(order: ReadonlyArray<string> | undefined, path: string): string[] {
  return order ? [...new Set(order.flatMap(ancestors))] : ancestors(path);
}

/** Select `path` alone, e.g. after a read-only viewer clicked elsewhere. */
function restore(model: ReturnType<typeof useFileTree>["model"], path: string) {
  for (const other of model.getSelectedPaths())
    if (other !== path) model.getItem(other)?.deselect();
  const item = path ? model.getItem(path) : null;
  if (item && !item.isSelected()) item.select();
}

const TREE_STYLE = {
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-input-bg-override": "var(--muted)",
  "--trees-accent-override": "var(--ring)",
  "--trees-selected-bg-override": "color-mix(in oklab, var(--primary) 26%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-theme-list-hover-bg": "var(--accent)",
} as React.CSSProperties;

/**
 * A file tree: the shared set's files (ADR 0002), or an agent's list at its
 * display paths (ADR 0005). Picking a file opens it in this frame;
 * ⌘/Ctrl-click opens it in a new one. `view` guests only ever get a list,
 * read-only.
 *
 * Memoized, and `onOpen` must be stable: pressing on a frame raises it, and a
 * re-render of the tree between pointer down and up loses the click.
 */
export const FileTree = memo(function FileTree({
  paths,
  selected,
  onOpen,
  order,
  badge,
  readOnly = false,
}: {
  /** null while the host's list hasn't arrived. */
  paths: ReadonlyArray<string> | null;
  /** The file to select; "" for none. */
  selected: string;
  onOpen: (path: string, newFrame: boolean) => void;
  /** Keep this order (an agent's list), all folders open; else the tree's own. */
  order?: ReadonlyArray<string>;
  /** A row's badge, e.g. its lines. */
  badge?: (path: string) => string | null;
  /** Show the selection, don't let it change. */
  readOnly?: boolean;
}) {
  const current = useRef(selected);
  const latest = useRef({ order, badge, readOnly });
  useEffect(() => {
    current.current = selected;
    latest.current = { order, badge, readOnly };
  });
  const { model } = useFileTree({
    paths: paths ?? [],
    initialExpandedPaths: expandedFor(order, selected),
    initialSelectedPaths: selected ? [selected] : [],
    flattenEmptyDirectories: true,
    search: true,
    density: "compact",
    ...(order && { sort: listOrder(order), initialExpansion: "open" as const }),
    renderRowDecoration: ({ row }) => {
      const text = row.kind === "file" ? latest.current.badge?.(row.path) : null;
      return text ? { text } : null;
    },
    onSelectionChange: (picked) => {
      if (latest.current.readOnly) {
        if (picked.length !== 1 || picked[0] !== current.current)
          queueMicrotask(() => restore(model, current.current));
        return;
      }
      const files = picked.filter((p) => !p.endsWith("/") && p !== current.current);
      if (picked.length === 1 && files.length === 1) onOpen(files[0]!, false);
    },
  });

  // The host re-sends the list whenever files come and go; an agent changes its list.
  useEffect(() => {
    if (!paths) return;
    // A list's order is fixed when the tree is made; a new one needs a new tree (see the key).
    const expanded = expandedFor(latest.current.order, current.current);
    model.resetPaths(paths, { initialExpandedPaths: expanded });
    // The tree finds initial folders by its default order, so a list's miss: open them here.
    if (latest.current.order)
      for (const dir of expanded) {
        const handle = model.getItem(dir);
        if (handle && "expand" in handle && !handle.isExpanded()) handle.expand();
      }
    restore(model, current.current);
  }, [model, paths]);

  // Someone else opened another file in this frame: follow it.
  useEffect(() => {
    if (!selected || model.getSelectedPaths().includes(selected)) return;
    const item = model.getItem(selected);
    if (!item) return;
    for (const dir of ancestors(selected)) {
      const handle = model.getItem(dir);
      if (handle && "expand" in handle) handle.expand();
    }
    for (const other of model.getSelectedPaths()) model.getItem(other)?.deselect();
    item.select();
    model.scrollToPath(selected, { offset: "nearest", focus: true });
  }, [model, selected, paths]);

  if (!paths)
    return <p className="text-muted-foreground p-3 text-xs">Waiting for the host's files…</p>;

  // ⌘/Ctrl-click opens a file in a new frame. The tree would treat it as
  // multi-select (and then swallow the next plain click), so it never sees it.
  const onModifierClick = (event: React.MouseEvent) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type !== "click" || readOnly) return;
    const row = event.nativeEvent
      .composedPath()
      .find((node): node is HTMLElement => node instanceof HTMLElement && !!node.dataset.itemPath);
    if (row?.dataset.itemType === "file") onOpen(row.dataset.itemPath!, true);
  };

  return (
    <div
      data-frame-body=""
      className="h-full"
      onPointerDownCapture={onModifierClick}
      onMouseDownCapture={onModifierClick}
      onClickCapture={onModifierClick}
    >
      <TreeView model={model} className="h-full" style={TREE_STYLE} />
    </div>
  );
});
