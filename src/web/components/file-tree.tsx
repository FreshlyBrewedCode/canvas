import { FileTree as TreeView, useFileTree } from "@pierre/trees/react";
import { memo, useEffect, useRef } from "react";

import { useTree } from "@/lib/room-context";

/** Every directory above a path, as the tree names them (`a/`, `a/b/`). */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`);
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
 * The shared set's files (ADR 0002), from the host. Picking a file opens it
 * in this frame; ⌘/Ctrl-click opens it in a new one. `view` guests never get
 * the list.
 *
 * Memoized, and `onOpen` must be stable: pressing on a frame raises it, and a
 * re-render of the tree between pointer down and up loses the click.
 */
export const FileTree = memo(function FileTree({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (path: string, newFrame: boolean) => void;
}) {
  const paths = useTree();
  const current = useRef(path);
  useEffect(() => {
    current.current = path;
  });

  const { model } = useFileTree({
    paths: paths ?? [],
    initialExpandedPaths: ancestors(path),
    initialSelectedPaths: path ? [path] : [],
    flattenEmptyDirectories: true,
    search: true,
    density: "compact",
    onSelectionChange: (selected) => {
      const files = selected.filter((p) => !p.endsWith("/") && p !== current.current);
      if (selected.length === 1 && files.length === 1) onOpen(files[0]!, false);
    },
  });

  // The host re-sends the list whenever files come and go.
  useEffect(() => {
    if (paths) model.resetPaths(paths, { initialExpandedPaths: ancestors(current.current) });
  }, [model, paths]);

  // Someone else opened another file in this frame: follow it.
  useEffect(() => {
    if (!path || model.getSelectedPaths().includes(path)) return;
    const item = model.getItem(path);
    if (!item) return;
    for (const dir of ancestors(path)) {
      const handle = model.getItem(dir);
      if (handle && "expand" in handle) handle.expand();
    }
    for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect();
    item.select();
    model.scrollToPath(path, { offset: "nearest", focus: true });
  }, [model, path, paths]);

  if (!paths)
    return <p className="text-muted-foreground p-3 text-xs">Waiting for the host's files…</p>;

  // ⌘/Ctrl-click opens a file in a new frame. The tree would treat it as
  // multi-select (and then swallow the next plain click), so it never sees it.
  const onModifierClick = (event: React.MouseEvent) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type !== "click") return;
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
