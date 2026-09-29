# 20 — Full screen

Date: 2026-09-29 · `e2e/drive.ts` `STEP=fullscreen` against an empty board. Host "Karl" and guest
"Ada" (edit access), Chromium via Playwright. Issue #27.

## Question

A frame on the board is rarely the size of the screen: working in one agent, file or drawing
means zooming and panning until it fills it, and again for the next. Can a person put one row of
frames on their screen, one frame at a time, without changing the board for anyone else?

## What was built

- **A mode of our own view, not of the board.** Full screen (`hooks/use-fullscreen.ts`) keeps one
  frame id in React state. Nothing goes into the board doc or presence; our `view` still goes out,
  so markers and following a view keep working for others.
- **The row is read off positions, every render** (`fullscreenRow` in `web/lib/fullscreen.ts`):
  the row of `shared/layout.ts` the frame is in, and its top. Peers adding, moving or removing
  frames change it as they go. Someone moving the row up or down, we glide after it.
- **A frame closed hands over.** When the frame full screen went to is gone (closed by us, a peer
  or an agent), it goes on to the next frame of the row as it was, else the one before
  (`standIn`), in a layout effect so no paint shows the board without it. The row's last frame
  gone ends it.
- **100%, the row's top under the top bar, the frame in the middle** (`fullscreenTransform`), or
  from its left edge when wider than the screen. The frames of the row are as tall as the board
  area and all at the row's top — locally: `FrameShell` reads top and height from
  `useFullscreenFrame` instead of the frame. The rest of the board is `visibility: hidden`, not
  unmounted, so terminals, previews and editors keep their state (and a hidden terminal isn't
  resized to nothing).
- **Terminals keep their height.** The host's terminal frame sizes the PTY for everyone
  (`resizeTerminal`); a host in full screen would give guests rows their frame can't show. A taller
  frame with its terminal the old size read as broken, so terminals stay as they are.
- **Moving about.** `useBoardViewport` got two things:
  - `glide`, an own move that eases (250 ms) instead of jumping: going to a frame.
  - `lockVertical`: drags, the wheel and trackpads pan along only. A mouse wheel, which only has
    up and down, pans along too.
- **Along the row:** H / L and Alt + ← / → go to the frame before or after the one nearest the
  middle of the screen (`currentIn`), which is also the filled dot in the bar. Alt + ← is the browser's Back, which
  board links use (ADR 0007): the handler takes it.
- **Ending it is a property of the view, not of each way out.** On every own move, full screen
  checks the transform still is one (`stillFullscreen`: scale 1, the row's top at the top) and
  ends otherwise. Zooming (wheel, pinch, buttons), a link going elsewhere, a peer's marker: all
  covered without knowing of them. Following a view isn't an own move; `Board` ends full screen
  when it starts. Esc, F, the header's button and ✕ end it too, and they glide back to the view
  full screen started from (kept on entering; going between frames keeps the first). Zooming,
  following and the like end it where it is: the view is theirs then.
- **Keys are the frame's while typing.** F, H, L and Esc go through the check Space uses
  (`typesText`: inputs, textareas, contenteditables; xterm's is a textarea), and not in a drawing
  being edited or a dialog.
- **Going to a frame occupies it**, as a press does (finding 08): `focusFrame`, then `detach` if
  someone else holds it.
- **A bar in the top bar**, not over the board: the frames' headers are at the board's top edge.
  Dots for the frames (their titles on hover), ‹ ›, ✕. The frame toolbar and zoom controls hide.
- **"+" beside the frame under the mouse**, in the gaps of the row: a menu of frame kinds, then
  `placeNew` to that side — the frames after it make room, the new frame gets the row's height —
  and full screen goes to it. The toolbar's frame defaults moved to `newFrame` in `lib/board.ts`.
- **Reordering only, in full screen.** A header drags along the row only (its y stays the doc's),
  always snapping, Alt and Shift ignored: `rowTarget` puts it after the last frame whose middle
  it passed, or before the first, then `moveFrame`. The preview takes full screen's top and
  height. On the drop the view glides after the frame. Held within 80 px of the board's left or
  right side, the drag scrolls the row that way (`edgeScroll`: faster the deeper, up to 24 px a
  frame, through `panBy`), the frame with it, until it is past the row's last or first frame
  (`scrollsFurther`). Corners don't resize: the frames show
  heights that aren't theirs, which a resize would write to the doc.

## Evidence

`STEP=fullscreen` — all 48 checks pass:

- A row of files, drawing and terminal, a browser under it. F over the files frame: scale 1, its
  top at the board's top (y 48), 852 px tall (the board area), centred; drawing and terminal in
  the row, the browser hidden. The terminal stays 380 px. The doc still says 400.
- Ada's board isn't full screen, her frames keep their heights; she sees Karl occupying the files
  frame.
- L goes to the drawing, centred; Alt + → to the terminal, the URL unchanged; L at the end stays;
  H and Alt + ← back to files, occupied again.
- Typing "f" into the frame's title stays full screen.
- Dragging the files header 700 px right and 100 px down shows a snap preview; dropped, files is
  at x 624, y 0 and the drawing at x 0: swapped, still full screen, the view on files, the dots in
  the new order.
- Held 2 s at the board's right side, the row scrolls and files drops past the terminal (x 1208,
  the terminal closing up to 624), last of the dots; held at the left side, back to first (x 0,
  terminal at 1248), the view on it.
- "+" right of the terminal, Drawing: a fourth frame at x 1248 + 560 + 24, the terminal row's
  height in the doc, and full screen on it.
- A vertical wheel over a gap pans 300 px along, y unchanged, still full screen.
- Ctrl + wheel ends it; the zoom controls come back. The header's button, Esc, ✕ and following
  Ada each end it; Esc and ✕ back to the exact transform before.
- Closing the files frame with its ✕ stays full screen, on the drawing (next in the row).
  Removing the rest of the row ends it.

`STEP=pan` and `STEP=arrange` pass unchanged.

## Open

- A frame much wider than the screen goes from its left edge, and H / L go frame by frame: there is
  no stepping inside it.
- Others don't see that someone is in full screen; their view marker shows where.
