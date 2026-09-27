# 12 — Comments on file frames

Date: 2026-09-27 · `e2e/drive.ts` `STEP=comments` (people) and `STEP=comments-agent` (agents),
against a scratch repo (`src/values.ts`: 80 lines `export const valueN = N; // line N`,
`src/deep/greet.ts`, `docs/readme.md`, committed). Host "Karl" and guest "Ada" (edit access),
Chromium via Playwright. Claude Code on Haiku 4.5, then opencode on its default model. Docs shot:
`e2e/screenshots.ts` `STEP=comments`. Decision: ADR 0006.
Versions: `@pierre/diffs` 1.5.1, `@pierre/trees` 1.0.0-beta.6.

## Question

Can people and agents comment on lines of a file frame's files, with the comments staying with
the frame and following their lines as agents edit the files, on top of what `@pierre/diffs`
already offers?

## What `@pierre/diffs` gives (spike)

- **Line annotations**: `lineAnnotations` (`{lineNumber}`, 0 = above the first line) with
  `renderAnnotation`. React content goes into a slot, in the light DOM, so the app's Tailwind
  styles apply. It works in the virtualized `File` and on a zoomed board.
- **Gutter utility**: `enableGutterUtility` + `onGutterUtilityClick(range)` puts a "+" by the
  hovered line number. With lines selected it sits at the selection's end and reports the range.
  `renderGutterUtility` (a custom button) can't be combined with `onGutterUtilityClick`. Its
  pointerdown starts a line selection instead of a click, so canvas uses the built-in button.
- **Pitfall**: a new `lineAnnotations` array re-renders the file. The board re-renders on every
  presence change (pointers), which removed the "+" as soon as it appeared. The list has to be
  stable (memoized by its lines).

## What was built

- `shared/comments.ts`: a file's lines as frames number them, a range's quote, and `relocate`:
  the quote's old place if it still reads the same, else the nearest copy, else null (outdated).
  Blank-only quotes never move.
- `web/lib/comments.ts`: `comments:<frameId>` maps in the board doc. The rules for who may
  change a comment (`mayChange`), and `settle`, which the host runs for the file its frame shows:
  it moves comments, marks them outdated, and back. Frames clear their comments when removed.
- The source view: the gutter "+" (not for `view` guests), a composer (⌘/Ctrl-Enter, Escape),
  comment cards with markdown bodies below their last line, outdated ones above line 1 with their
  quote. Everyone places comments against the text they have; only the host writes moves.
- The frame: a header button with the count and a popover by file. Picking a comment calls the
  same path as picking a list entry, so the frame shows its file at its lines, in source. The tree's
  buttons (hide, list/all) move to a toolbar above its search, with a filter to commented files.
  Rows show a coloured count. **Show files** sits in the header while the tree is hidden, and
  opens a never-opened tree at its default width instead of its minimum.
- Agents: `view_frame`, `add_comment`, `edit_comment`, `delete_comment`, the comment count in
  `view_board`, `comment` on `update_frame`. `canvas serve` reads an agent comment's quote from the
  shared set (`board-mcp.ts`) and overwrites any quote the agent sent.

## Evidence

### People (`STEP=comments`, all 24 checks pass)

- No comments: no header button. Karl comments on L10 via the "+" → Ada sees it, `**ten**`
  rendered bold.
- Ada selects 20–22, clicks "+" → comment on L20–22 with a three-line quote, by "Ada".
- Ada can't edit Karl's comment, can edit her own. Karl (host) can edit Ada's. Ada's edit reaches
  Karl.
- The header counts 2. The tree row reads `values.ts ● 2`.
- Karl opens `docs/readme.md` → still 2. Ada picks her comment in the popover → the frame shows
  `src/values.ts` L20–22 for everyone.
- A comment on `docs/readme.md` (in source), then picked from the popover while the frame showed
  another file → `docs/readme.md`, view `null` with lines, so source.
- Three lines inserted at the top of `values.ts` on disk → the L10 comment moves to L13. Its line's
  text changed → outdated, shown above line 1 with the old line. The file restored → back at L10,
  not outdated.
- Filter → the tree shows only `docs/readme.md` and `src/values.ts`.
- Hide files → Show files in the header. The host deletes Ada's comment → gone for Ada.
- Access `view` → Ada gets no "+". ⌘/Ctrl-click opens `values.ts` in a new frame → no comments.
  Removing the frame → its comment map is empty.

### Agents (`STEP=comments-agent`, all 7 checks pass for both)

Karl's comments (written into the doc): L20–22 of `values.ts`, "What is the sum of the three
values on these lines?", and L2 of `src/deep/greet.ts`, "Which greeting word does this use?".

|                                         | Claude Code (Haiku 4.5)                                       | opencode                                  |
| --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| "Read Karl's comments, answer each, comment on L40" | `view_board`, `view_frame`, 2× read, `add_comment`; 63 and "hi"; comment "Exports `value40`" | same calls; "Exports `value40` (= 40)." |
| "Change yours to 'checked', delete Karl's" | `edit_comment`, then `delete_comment` → refused; told the user | `edit_comment` only: it read the tool description and declined |
| "Point that frame at Karl's comment"    | `update_frame` with the comment → L20–22                       | same                                      |

- The agent's comment carries `author: {kind: "agent", frame, name: "claude-1"}` and the quote of
  L40, read by `canvas serve`. The guest sees it.
- Asked only to "show me" Karl's comment, Claude quoted it in its reply and didn't move the frame.
  With "point that frame at it", both agents used `update_frame`.
- The first run failed because `canvas serve` still ran the code from before the new tools. Agents
  get the tool list when a session starts.

## Found on the way

- **The header drag ate popover clicks.** The popover is portalled, but React bubbles its
  pointerdown to the frame header, which starts a drag with pointer capture, so the click never
  lands. `stopPropagation` on the popover content fixes it. The agent-settings popover has the
  same structure.
- **Emoji don't render in the tree's font** (💬 drew an empty box): the count uses a coloured `●`.
- **`FileTree` decorations** are drawn as rows render. `model.setComposition(model.getComposition())`
  redraws them when counts change, without resetting the tree.

## Open

- Comments on a file no frame shows move only once it is shown again. The quote still finds its
  lines, unless it now occurs nearer somewhere else.
- The rules for changing comments hold in the app only (ADR 0006 §4). The host would need to
  inspect guests' Yjs updates to enforce them.
- No replies, no resolving, no notifications to agents: flat notes, read on request.
- Folders in the tree don't show the counts of the files below them.
