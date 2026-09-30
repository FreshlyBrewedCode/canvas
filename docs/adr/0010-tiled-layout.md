# 0010. The board is a tree of clusters, rows and columns; positions are derived

## Status

Proposed, 2026-09-30 (epic #51). Replaces the layout rules of ADR 0003 (decision 4 stands:
agents name frames and sides, never pixels) and of findings 07, 10 and 20.

## Context

The board started as a free canvas: every frame stores x, y, w, h, and `shared/layout.ts` reads
structure off them on every render — frames within 48 px are a cluster, tops within 16 px a row.
Each operation reads the structure off pixels, writes pixels, and hopes the next read finds what
it meant. In use this shows:

- Snapping depends on the dragged frame, not the pointer: the nearest frame within 48 px, the side
  from the frames' centres scaled by their sizes. The same pointer gives different results for
  different sizes and grab points; getting into the row above takes lining the frame up just so,
  else it makes a new row.
- A drag writes positions to the doc every animation frame, so clusters and rows change for
  everyone while it goes. In full screen, dragging a frame past the row's end splits it off into
  its own cluster, and the row full screen shows falls apart under the drag.
- A 24 px gap everywhere, dead space in full screen; resizing from one corner only, and not at all
  in full screen.
- Full screen and following are pixel rectangles, which don't carry between screens of different
  sizes.

Meanwhile the board is used as rows of frames, more and more through full screen: like a
scrollable tiling window manager (niri, PaperWM) — a row a strip, one frame at a time, stepping
along it. The layout should be built for that and stay open to going further that way, without
another rebuild.

## Decision

1. **Structure is stored, positions are derived.** The board is a tree:

   ```
   board → cluster (name) → row (h) → column (w) → frame (weight)
   ```

   Containers are entries of a `layout` map `{ kind, parent, pos, …size }`; frames carry
   `parent`, `pos` and `weight`, their content stays where it is. `pos` is a fractional index, so a
   move is a few field writes on one node: concurrent moves resolve last-writer-wins, and nothing is
   duplicated (Yjs arrays have no move). Frames no longer store x and y.

2. **One module turns structure into pixels.** `resolve(tree, context)` in `shared/layout.ts` is
   pure and the same on every peer; `context` is what differs between views (the board, full screen
   and its screen height). It repairs what concurrency leaves: a node whose parent is gone goes to
   the end of the nearest ancestor that is left, in new containers as needed; empty containers are
   ignored, and the host's browser removes them. Operations (`insert`, `move`, `remove`, `resize`)
   take structural targets. The drag UI, full screen, the keyboard and agents speak targets; none of
   them compute positions.
3. **Clusters are arranged, not placed.** The board is rows of clusters, top-aligned, with a gap
   between clusters. Clusters don't overlap and don't merge; one that grows moves the others. A
   cluster moves like a frame, to a slot. A lone frame is a cluster of one.
4. **No gap inside a cluster.** Frames share their borders; a shared edge is one handle. Every
   edge resizes: a vertical one the column's width (it grows, the rest of the row moves along), a
   horizontal one the row's height. In full screen, widths only.
5. **Drops go by the pointer, not by the frame's geometry.** Over a frame: its left or right edge
   puts the dragged frame before or after it in its row; its top or bottom edge makes a new row
   above or below; its centre is for columns (later: above or below the middle stacks it on top or
   under). Between clusters or on empty board: a new cluster there. A drag is its own until the
   drop, one transaction; peers see a ghost of it through presence.
6. **Columns are in the model from the start,** one frame each until stacking comes. In a column
   frames share its height by weight, on the board and in full screen alike.
7. **Terminals are sized by the host's screen.** The host's terminal sizes the PTY for everyone
   (finding 20), so a terminal's height is pixels of the host's screen, not a weight: by default a
   share of it (a half, say), kept in full screen; what the host sets, everyone shows, taller or
   shorter than their screen. In a column the other frames share what is left.
8. **Views are each person's own, anchored to the structure.** The current frame is the one we
   occupy (finding 08); in full screen, the one in the middle. Presence carries it and whether we
   are in full screen, besides our view rectangle: following someone in full screen is full screen
   on their frame at our screen's size, and others see who is in full screen where. When the layout
   changes under us, the current frame stays where it was on our screen and the rest moves around it.
9. **The keyboard is moves over the tree, for the left hand** (vim keys as aliases), unless typing
   or drawing:

   | keys              | move                                                                        |
   | ----------------- | --------------------------------------------------------------------------- |
   | W A S D (H J K L) | to the neighbouring frame that way; the view goes along if it is off screen |
   | Shift + W A S D   | move the current frame that way: along its row, or into the row beside      |
   | Q / E             | the cluster before / after                                                  |
   | F                 | full screen on the current frame, or back                                   |
   | Shift + F         | the whole board; again, back                                                |
   | 1 – 5             | a new frame of a kind beside the current one                                |
   | Esc               | out of the frame, to the board: the keys above work again                   |
   | Space (held)      | pan                                                                         |

10. **Agents' tools stay.** `next_to` and `side` map to targets; `view_board` reads the tree.

Not in this step: stacking frames in a column (the centre drop zone), an overview that shows titles
readably and doesn't render frame content when zoomed far out, width presets for full screen.

## Considered options

- **Keep positions as the truth, fix the heuristics.** Every fix leaves structure a guess, and
  every change of pixels (a drag, a resize, a peer's edit) a chance to change it.
- **Clusters placed freely, pushed apart when they meet.** Keeps the whiteboard feel, but leaves
  what to push, and where, for every growth, and two people's pushes to fight. The board node can
  get a free mode later if it is missed.
- **Rows and frames in Y.Arrays.** Plain to read, but a move is delete and insert, and two peers
  moving one frame get it twice.

## Consequences

- Boards from before are migrated once: today's `clusters()` reads their structure.
- The `Frame` read model keeps x, y, w, h, derived: the viewport, links, markers and navigation
  hardly change.
- Nothing is placed freely any more; a frame on its own is a cluster in the arrangement.
- Going further as a tiling window manager — stacking, tabs in a column, a scrolling strip per
  row — is new kinds and operations, not new storage.
- On implementation, `site/content/docs/board.md`, the glossary (cluster, row, column, full
  screen) and `limits.md` change with it.
