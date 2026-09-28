# 17 — Drawing frames (Excalidraw)

Date: 2026-09-27 · a throwaway spike (two Excalidraw instances in a `scale(0.5)` container, two
linked Y.Docs, Playwright), then `e2e/drive.ts` `STEP=drawing` (people) and `STEP=drawing-agent`
(agents) against the demo project of `e2e/screenshots-demo.sh`. Host "Karl" and guest "Ada" (edit
access), Chromium via Playwright. Claude Code on Haiku 4.5, opencode on OpenCode Zen's Big Pickle.
Docs shots: `e2e/screenshots.ts` `STEP=drawing`. Decision: ADR 0009.
Versions: `@excalidraw/excalidraw` 0.18.1, `@excalidraw/mermaid-to-excalidraw` 2.2.2.

## Question

Can a frame be an Excalidraw drawing that everyone on the board draws on together, which agents
can look at (as an image) and draw on?

## Spike: Excalidraw under the board's zoom

The board zooms with a CSS `transform: scale` on the frames' container. Excalidraw ignores it:

- **Pointers land off by the scale.** At 50%, a drag from scene (200,200) to (400,400) drew a
  rectangle at (100,100), 100×100: Excalidraw maps client coordinates by its bounding box without
  dividing by the scale.
- **Its canvas covers a corner.** It sizes the canvas from the (already scaled) bounding box, which
  the transform then scales again: it draws in the top-left quarter of the frame.
- **Its UI goes to the phone layout**, from the scaled size.

**Undoing the scale works**: an inner box of the frame's size × scale, `scale(1 / scale)`, has no
net transform; Excalidraw's own zoom is set to the board's instead. The same drag then drew at
(200,200), 200×200, rendered in full. Two more things it needs:

- Excalidraw caches where it is on screen, and the board moves it without an event. `refresh()` on
  `pointerenter` looks again before the next press.
- ⌘/Ctrl-wheel over it zooms Excalidraw, so the editor stops that wheel event from reaching the
  board. The plain wheel already stays in frames marked `data-frame-body`.

Its UI stays at screen size, so a small or zoomed-out frame gets cramped: Excalidraw switches to its
compact toolbars below about 500 px of height on screen. Hence a picture at rest (SVG,
`exportToSvg`), zooming with the board like any frame, and Excalidraw only while someone edits.
The editor opens at the picture's view (`restingView`: fitted, never enlarged, centred), so
nothing moves on the switch. A new drawing is 960×640, enough for the full toolbars at 100%.

## Spike: sync

- **A `Y.Map<id, element>`, newer `version` wins.** Excalidraw numbers every change to an element;
  its own collaboration reconciles by version (`reconcileElements`). Writes go when ours is newer
  than the doc's; the doc's element is taken unless ours is newer. Equal versions from two peers
  are settled by the doc, which all agree on. Removals are `isDeleted` versions. 0.18's fractional
  `index` keeps the stacking order in a map.
- **Pitfall: Excalidraw changes elements in place.** Storing its objects in the map meant the next
  change compared an element with itself: the guest kept the rectangle at 0×0, its first version.
  The map stores copies, and the editor gets copies of the doc's.
- **Pitfall: the host's own writes aren't all its editor's.** An agent's `draw` runs in the host's
  browser, a local transaction like the editor's. The editor tags its writes with an origin of its
  own and takes every other change.
- `y-excalidraw` (the existing binding) supports Excalidraw 0.17 only, last released in 2024.
- Remote changes enter with `CaptureUpdateAction.NEVER`, so undo takes back only your own.

## Spike: agents

- `exportToBlob` renders a PNG in the host's browser (14–26 KB for a small drawing).
- `convertToExcalidrawElements` turns element skeletons (`{type, x, y, width, height, label}`,
  arrows with `start`/`end` ids) into elements. **It binds an arrow to its shapes but leaves it
  where it was given**, so canvas routes an arrow between two shapes itself, outline to outline.
  Arrows to shapes already drawn: the shapes go through the conversion too, and come back as they
  were, with the new arrow in their `boundElements`.
- `parseMermaidToExcalidraw` turns flowcharts, sequence and class diagrams into skeletons; other
  diagrams come back as an image, which canvas refuses.
- Cost: about 1.2 MB gzipped with mermaid, loaded only when a board has a drawing. By default it
  fetches its fonts from esm.sh; `EXCALIDRAW_ASSET_PATH` points it at the app, which serves them
  (14 MB, loaded as needed).

## What was built

- `web/lib/drawing.ts`: the map, `writeElements`/`mergeElements`, the agent side (`checkSkeletons`,
  `routeArrows`, `drawChanges`: add on top, replace by id where it stacked, remove with labels,
  clear) and `describeDrawing`, the text agents get.
- `web/lib/drawing-kit.ts`, lazy: `prepareDrawCall` (skeletons and mermaid to elements, before the
  board tool runs), `drawingImage` (the PNG, after), `renderSvg`. The board tools stay synchronous.
- `components/drawing-frame.tsx` (picture, Edit/Done, double-click, click outside ends),
  `components/drawing-editor.tsx` (Excalidraw with the scale undone, sync, links through the
  board's link handling, embeds off, images off).
- Tools: `open_frame` type `drawing`, optionally with `elements`/`mermaid`; `view_frame` on a
  drawing returns text and the image; `draw` (`elements`, `mermaid`, `delete`, `clear`).
  `board-result` carries images; `canvas serve` passes them as MCP image content.

## Evidence

### People (`STEP=drawing`, all 12 checks pass)

- At 80%, Karl's rectangle dragged over 200×160 screen pixels is 250×200 in the drawing, where
  the pointer drew it. Ada's picture has it at its final size.
- Ada edits while Karl does; her ellipse reaches Karl's editor. Karl's undo takes back his
  rectangle only, redo brings it back.
- A click outside ends editing; the picture zooms with the board (×1.25 per step).
- A `view` guest gets no Edit, and no editor on double-click. Removing the frame clears its map.

### Agents (`STEP=drawing-agent`, 9 checks)

Karl sketches a house with the pen (three freehand strokes: only in the image). Then: "what did
Karl sketch?", "add a mermaid flowchart guest browser → host browser → canvas serve → agent below
it", "add a red ellipse 'you' with an arrow from the agent box", "remove them again".

|                                   | Claude Code (Haiku 4.5)          | opencode (Big Pickle)                |
| --------------------------------- | -------------------------------- | ------------------------------------ |
| Reads the sketch from the image   | "a simple house with a triangular roof and a door" | no: "this model has no image input"; it said so and used the list |
| Mermaid flowchart below it        | yes                              | yes                                  |
| Red ellipse, arrow bound to box   | yes; the box keeps its old arrows | yes, in one `draw`                  |
| Removes them, sketch untouched    | yes                              | yes                                  |
| Result                            | 9/9 when it loads the tools (below) | 8/9 (the image)                   |

- **Claude Code's tool search.** Claude Code defers MCP tools until the model looks them up. Haiku
  sometimes called `view_frame` without loading it, with no arguments ("no frame undefined"),
  then gave up on the drawing or wrote the diagram into a scratch file instead: 2 of 4 runs.
  With `ENABLE_TOOL_SEARCH=false` it passed 3 of 3, but canvas leaves Claude Code's settings
  alone: this is a weak model's slip, not the tools'. A missing `frame` or `type` now says so,
  for the model to recover.
- **`<br>` in mermaid labels.** Claude breaks labels with `<br>`, which came out as text;
  converted to newlines.
- **Big Pickle's arguments.** It sent numbers as strings (`"x":"465"`) and, while the element
  schema was loose, arrays as `{"item": …}`: "needs numbers x and y" for every element. Numbers
  and JSON in strings are read now, the schema types every field, and errors quote what came.
- **Images in the thread.** opencode returns the image as a data-URL attachment in its tool
  output; `trim-event.ts` drops those as it does image content.

## Open

- Images in drawings (Excalidraw keeps their files apart from the elements; they'd need to sync
  too, and are large for trystero).
- Other people's cursors and selections inside a drawing (Excalidraw's collaborators API); the
  board's pointers show over it already.
- Removed elements stay in the doc forever.
- A drawing is only on the board: no `.excalidraw` file, no export into the project.
- Board zoom below 10% drives Excalidraw's zoom below its minimum while editing.
