# 05 — A files frame guests can browse, without a door to the machine

Date: 2026-09-26 · Scripts: `spikes/04-files-escape.ts` (what a board path reaches),
`spikes/05-files-list-watch.ts` (listing and watching cost), `spikes/06-files-scratch-repo.sh`
(the validation project), `e2e/drive.ts` `STEP=files`. Decision: ADR 0002.
Versions: `@pierre/trees` 1.0.0-beta.6, `@pierre/diffs` 1.5.1 (Shiki 4), `react-resizable-panels`
4.13.3, Bun 1.4.2, Chromium via Playwright 1.63.

## Question

Can the markdown frame become a general files frame — any text file, a file tree, markdown
rendered by default, shared selections — while guests reach nothing on the host's machine
beyond what the host means to show?

## The markdown frame was already a door (spike 04)

A frame's path lives in the board, which any `edit` guest can change without approval, and
`Files` only checked the path *text*. Against the old code:

| board path | result |
|---|---|
| `.canvas/room.json` | read — host token and the host's ECDSA private key |
| `.env` | read |
| `etc-link/hostname` (`etc-link → /etc`) | read `/etc/hostname` |
| `etc-link/canvas-spike-write` | write attempted, only the OS said no |

The Y.Text of a markdown frame was also written back to disk, so an `edit` guest could write
any project file. After `7317f91` every one of these is refused (`shared-set.ts`).

## Listing and watching are cheap enough (spike 05)

| | t3code (21 476 files) | canvas |
|---|---|---|
| `git ls-files --cached --others --exclude-standard` | 49 ms, 1.5 MiB JSON / 130 KiB gzipped | 2 ms |
| `find` incl. ignored | 48 ms | 36 ms (18k, mostly `node_modules`) |
| Bun recursive `fs.watch` set-up | 36 ms | 23 ms |

- Bun's recursive watch on Linux reports nested changes, including in directories created
  after it started — one watcher serves every open file and the tree.
- An `lstat` per listed path (to drop symlinks leaving the set) costs ~280 ms on t3code — too
  slow for every change. `git ls-files --stage` marks tracked links (mode `120000`), so only
  untracked files need an `lstat`.

## What was built

- **Server** (`shared-set.ts`, `files.ts`): the shared set of ADR 0002; `file-open` /
  `file-close` / `tree-watch`; content as `text | missing | binary | too-large | denied`, no
  write. One recursive watcher, changes settled for 150 ms, `.canvas/` ignored.
- **Host relay** (`room.ts`): opens exactly the paths file frames show, mirrors files and the
  tree like terminals; the tree never goes to `view` guests (sent when the host opens up).
- **Frame** (`file-frame.tsx`, `file-tree.tsx`, `code-view.tsx`): collapsible, resizable tree
  (per viewer); source through `@pierre/diffs`' virtualized `File` (Shiki, language from the
  name, markdown wraps); markdown preview by default with a shared preview/source toggle;
  ⌘/Ctrl-click opens a file in a new frame. Old boards' `markdown` frames open as file frames.
- **Selections**: preview text via the thread mechanism (blocks keyed by source line), source
  lines via line-number selection, drawn for others with CSS in the view's shadow root.

## Validated (`STEP=files`, host "Karl" + guest "Ada", scratch repo of spike 06)

- Tree for the guest: `docs e2e src .env.example .gitignore big.ts logo.png package.json
  setup.sh` — no `.env`, `certs/server.key`, `dist/`, `node_modules/`, `debug.log`,
  `etc-link`, `env-link.md`.
- Host picks `docs/adr/0002-….md` → the guest sees it rendered; host toggles to source → the
  guest's frame switches too.
- Guest selects "markdown frame" in the preview (block `L9`) → drawn on the host in Ada's
  colour. Guest drags line numbers 3–6 in the source → the host sees lines 3–6 highlighted,
  labelled "Ada".
- Guest picks `src/server/files.ts` in the tree → the host's frame follows. The file is
  rewritten on disk → the guest sees the new content live.
- Guest ⌘/Ctrl-clicks `src/generated.ts` (8 000 lines) → a second frame opens, highlighted,
  virtualized.
- `big.ts` (1.5 MiB) → "Too large to show"; `logo.png` → "Binary file".
- Paths the guest writes into the board directly: `.env` → "looks like a secret",
  `.canvas/room.json` → "canvas never shares .git or .canvas", `etc-link/hostname` → "git
  can't place it (a symlink?)", `../../etc/passwd` → "outside the working dir".
- Host hides its tree → the guest's tree stays open. Access `view` → the guest still sees the
  file the host opens, but gets neither the tree nor the toggle.

## Found on the way

- **Frames rendered in z order lost clicks.** Raising a frame moved its DOM node between
  pointer down and up; a tree row needed two clicks, and a browser frame would reload. Frames
  now render in a stable order and stack by z-index only (`b874732`).
- **Every file opened scrolled to its end.** The diffs virtualizer anchors to a file's bottom
  while the file sits at the top with no height yet; a few pixels of padding fix it
  (`0ea0f4b`).
- **The tree's ⌘/Ctrl-click is multi-select**, after which it swallowed the next plain click;
  canvas intercepts modifier clicks before the tree sees them.
- Remote carets and highlights in `@pierre/diffs` exist only in its edit mode, hence the
  shadow-root CSS for read-only line selections.

## Open

- **Resizing the tree on a zoomed board lags the pointer**: at 80 % a 60 px drag moves the
  handle 47 px. `react-resizable-panels` divides screen-pixel pointer deltas by the unscaled
  `offsetWidth` of the group (`react-resizable-panels.js`, the `clientX - s.x) / v` line); a
  one-line `bun patch` scaling `v` by the group's rendered/offset width ratio would fix it.
- The set is fixed by rule. A secret in a tracked, unusually named file is shared; a
  `.canvasignore` would be the next step.
- The tree listing goes to every non-`view` guest whole (~130 KiB gzipped at 21k files, sent
  uncompressed today).
- Preview selections disappear when a block above them changes (their key moves with the
  source line) — by design, rather than pointing at the wrong text.
- Unchanged by this work, but worth remembering: an agent can `cat .env` into its thread,
  and `trusted` guests have a terminal.
