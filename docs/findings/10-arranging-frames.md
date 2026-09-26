# 10 — Arranging frames, validated

Date: 2026-09-26 · `e2e/drive.ts` `STEP=arrange` against a scratch repo (any will do: the step
uses empty files frames, 600×400). Host "Karl" and guest "Ada" in separate browsers (Chromium via
Playwright). Builds on the layout rules of finding 07.

## The problems

- Dropping a frame between two others already put it in between, but the preview was the same
  dashed outline as any drop, drawn on top of the frames about to make room.
- A frame snapped somewhere else left a hole in its old row: the drop lifted it from where it was
  being dragged, not from where it came from. The **×** left a hole always (only an agent's
  `close_frame` closed up), and no removal closed a row left empty.
- A cluster could only be moved frame by frame.
- The title field spanned the header, so most of the header edited the title instead of dragging.

## What was built

- `src/shared/layout.ts`: `lift` closes a row left empty — the rows below move up into it — as
  well as the gap in a row. `insertion(rects, target, movingId)` says whether a placement goes
  between two frames of a row or two rows, and returns the gap's centre line.
- The drag in `frame-shell.tsx` lifts from where the drag began; the **×** lifts too. The preview
  (`snap-preview.ts`) is `place` (the outline) or `insert` (a dotted line, 4 screen px at any
  zoom).
- Shift while dragging carries the frame's cluster along, offsets kept, no snapping. Letting go
  of Shift mid-drag puts the others back.
- The title field is as wide as its text (a hidden copy sizes it), at least 4ch; the header keeps
  at least 48 px to drag by.

## Results (`STEP=arrange`)

| action                                        | result                                           |
| --------------------------------------------- | ------------------------------------------------ |
| D (alone in row 2) dropped between A and B    | vertical dotted line; row A D B C, row 2 gone     |
| D dropped past C, the row's end               | outline; B and C close D's old place             |
| D dropped between row A B C and row E         | horizontal dotted line; D a row between, E down  |
| **×** on B, then on D (alone in its row)      | C moves into B's place; E's row moves up         |
| A snapped next to a frame 4000 px away        | C moves to the old row's start                   |
| Shift-drag C by (200, 1500)                   | no preview; E moves along, the far frame stays   |
| title field of "files-3"                      | 48 of a 152 px header (fit view)                 |
| drag by the header beside the title           | the frame moves; clicking the title edits it     |

## Open

- Moving a cluster doesn't snap it to anything, and can drop it into another cluster, which then
  merges (as a single frame's drop already could).
- No undo: a removed frame is gone.
