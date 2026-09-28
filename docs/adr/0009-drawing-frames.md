# 0009. Drawing frames are Excalidraw elements in the board doc

## Status

Accepted, 2026-09-27 (prototype). Evidence in `docs/findings/17-drawings.md`.

## Context

People planning together on the board want to sketch: an architecture, a flow, a screen. Agents
should see those sketches and add to them. Excalidraw is an embeddable whiteboard with a React
component, a JSON element model with a version per element, and functions to render and to build
elements from descriptions. The board is a Yjs doc that guests write into unchecked (ADR 0001),
zoomed by a CSS transform; agents act on it through the host's browser (ADR 0003), and URLs are
the viewer's own business (ADR 0004).

## Decision

1. **A drawing lives in the board doc, nowhere else.** A drawing frame's elements are a map
   `drawing:<frameId>` of Excalidraw elements. A change is written when it is newer (`version`)
   than the doc's and taken from the doc unless ours is newer, as Excalidraw's own collaboration
   does. It syncs and persists like the rest of the board, and goes with its frame. No
   `.excalidraw` file in the project: files stay read-only (ADR 0002).
2. **A picture at rest, Excalidraw while you edit.** Excalidraw can't live under the board's CSS
   scale, and its UI doesn't shrink with the board. So the frame shows an SVG that zooms like any
   frame. Double-click or Edit opens Excalidraw for that person, with the board's scale undone and
   its own zoom set to it, at the picture's view. Everyone else sees the changes live. Undo is
   your own.
3. **Agents look through an image and a list, and draw by description.** `view_frame` returns the
   drawing as a PNG and as text: shapes with ids, labels, places, and what arrows connect. `draw`
   takes Excalidraw's element skeletons, or a mermaid diagram, and replaces or removes elements by
   id. The host's browser turns them into elements and renders the image, around the board tool
   call, so the board tools stay plain functions of the doc. `board-result` carries images;
   `canvas serve` passes them on as MCP image content. Whether a model reads the image is its own
   matter: the list stands on its own.
4. **Nothing in a drawing reaches past the board.** Embedded web pages don't load (they would
   load any URL in everyone's browser, around ADR 0004). Links on elements go through the board's
   link handling (ADR 0007), web links to a new tab. Agents draw only shapes, text, arrows and
   lines. Images aren't synced, so the image tool is off.
5. **Excalidraw loads only for boards with drawings,** and its fonts come from the app, not from
   its CDN.

## Consequences

- A drawing is as trustworthy as any board data: an edit guest's modified client can write any
  element. It renders in Excalidraw's own renderer, and embeds and images don't load.
- Agents' drawings and people's are the same elements; people move and restyle what an agent drew.
- Elements are never removed from the doc, only marked, as Excalidraw keeps them.
- Models without image input still work with drawings, but miss freehand strokes.
