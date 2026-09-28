# 18 — Following the file tree

Date: 2026-09-28 · `e2e/drive.ts` `STEP=focus-tree` against a scratch repo with nested folders
(`src/{alpha,beta,gamma,delta,epsilon}/{one,two,three}/f1..f8.ts`), and `STEP=focus` again for
finding 08. Host "Karl" and guest "Ada" (edit access), Chromium via Playwright.
Version: `@pierre/trees` 1.0.0-beta.6.

## Question

Frame focus (finding 08) left a files frame's tree out: which file is shown is shared, but the
tree panel was each viewer's own, so "look in `src/auth/`" still meant saying where. Can the tree
follow the frame's occupant like its scroll does?

## What the tree lets us read and set

| State | Read | Set | Told by |
|---|---|---|---|
| Open folders | `getVisibleRows(0, getVisibleCount())`, directories with `isExpanded` (no `getExpandedPaths`) | `getItem(dir).expand()` / `.collapse()` | `model.subscribe()` |
| Scroll | `[data-file-tree-virtualized-scroll]` in the tree's open shadow root | the same element | `scroll` |
| Search | `isSearchOpen()` / `getSearchValue()` | `setSearch(value \| null)` (null closes it) | `model.subscribe()` |
| Panel open, width, list or all files, commented only | `file-frame.tsx` state, the panel's `onResize` | `PanelImperativeHandle`, state setters | — |

Only the folders showing need to go: one open inside a closed one looks the same. Rows have a
fixed height and frame sizes are shared, so the scroll offset lines up once the folders do.

## What was built

- **The tree is presence, next to the scroll** (`TreeView` in `web/lib/focus.ts`). `Focus` had
  one `scroll`, which a file frame's source or preview already uses; the tree gets its own field:
  `panel` (which tree, or null when closed), `size`, and `of`, `expanded`, `search`, `top` for
  the tree they were read from. Two parts publish it, merged by `Room.publishTree`.
- **The panel** (`useFollowTreePanel`, `file-frame.tsx`): the occupant publishes open or closed,
  which tree (`list`, `all`, `-commented`: the `FileTree` keys) and the width; followers open,
  close, switch and resize theirs. A `view` guest only has the list, and keeps it.
- **The tree** (`useFollowTree`, `file-tree.tsx`): the occupant publishes its open folders,
  search and scroll on every change (rAF-throttled). Followers close the folders the occupant
  hasn't open, open theirs, search what they search, then scroll once the rows are laid out.
  Only the same tree follows (`of`). None of it re-renders the tree: a re-render between pointer
  down and up loses the click (`FileTree`).
- **Doing anything in the tree detaches**: a press, a key (search, arrows), wheel or touch in the
  tree, its toolbar or the panel's handle, or "Show files". As with scrolling, it detaches the
  whole frame, for that viewer only; the avatar follows again.
- A person's presence changes with every pointer move: followers compare the tree they last
  applied, not the object, so they don't walk the tree on every move.

## Evidence

`STEP=focus-tree` — all 19 checks pass:

- A new files frame opens with its tree. Karl hides it (the press claims the frame): Ada follows
  him there, and her tree closes. He shows it: hers opens, 32% wide as his.
- Karl opens `src/`, `src/alpha/`, `src/alpha/two/`, `src/gamma/`, `src/gamma/three/`: Ada has
  the same folders open. He scrolls the tree to 225 px: so is hers. He closes `src/alpha/`: hers
  closes.
- Karl searches `f7`: Ada's tree shows `f7` in its search, and the same folders open.
- Ada opens `src/beta/`: she stops following. Karl closes `src/gamma/`; Ada's stays open, and her
  `src/beta/` too. She clicks Karl's avatar: her tree is his again.
- Karl drags the panel wider (32% → 45%): so is Ada's. He hides it: hers closes.

`STEP=focus` — all 16 checks of finding 08 still pass.

## Notes and limits

- Awareness sends a peer's whole presence with every update, so the open folders go along with
  every pointer move and scroll. Fine for trees people open by hand; if it isn't, publish
  folders in their own presence field only when they change.
- Folders flattened into one row (`flattenEmptyDirectories`) go by the row's path; whether
  `getItem` opens them from it is not checked (the scratch repo has none).
- Agents have no tree to publish. `open_file` already points the frame at a file, which opens
  the folders above it for everyone.
