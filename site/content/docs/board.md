---
title: Board
description: Frames, layout, navigation and presence.
section: Features
order: 1
---

The board is one shared surface. Every frame's position, size and title is shared: when someone
moves a frame, everyone sees it move.

## Navigate

| Do                                   | To                    |
| ------------------------------------ | --------------------- |
| Drag the empty board                 | Pan                   |
| Drag with the middle button, anywhere | Pan                  |
| Hold Space and drag, anywhere        | Pan                   |
| Wheel, or swipe on a trackpad, outside a frame's content | Pan |
| ⌘/Ctrl + wheel, or pinch             | Zoom about the pointer |
| **−** / **+** in the corner          | Zoom out / in         |
| Press the zoom percentage            | Back to 100%          |
| **Fit** (the arrows in the corner)   | Fit every frame into view |

The middle button and Space pan over frames too, without touching them. Space is a space while you
type into something: a prompt, a terminal, a title. Press the board first. A drawing being edited
keeps both for its own canvas, and a press inside a browser frame's page never reaches the board:
hold Space there, or drag its header.

The viewport is yours alone; it is kept per board in your browser.

## Links

Links in agent replies, comments and markdown and HTML files go to places on the board: a frame,
a file, lines of it, a markdown heading or a comment. They show as chips. Inline code that names a
file of the project, like `src/auth/session.ts:42`, is a chip too.

- **Following a link is yours.** The view moves to the frame, and you occupy it, or go your own
  way in it if someone else does ([Focus](/docs/focus)). Lines are scrolled to and become your
  selection; a heading is scrolled to.
- **What frames show is shared.** A file no frame shows opens in a new frame beside the link. A
  frame the link names switches to the file, and to source for lines, or preview for a heading,
  as picking it in the tree would. `view` guests go to frames but open none.
- **Back and Forward** go between the places links took you. The page URL then names the place, so
  a guest link with `&frame=<id>` added opens the board at that frame.
- **Web links** open in a new tab.

Links are ordinary markdown links. A path is from the project root, or, in a file, from that file:

| Link                                  | Goes to                                  |
| ------------------------------------- | ---------------------------------------- |
| `[x](src/a.ts)`                       | The file                                 |
| `[x](src/a.ts#L10-L20)`, `src/a.ts:10-20` | Lines of it                          |
| `[x](docs/guide.md#install)`, `[x](#install)` | A heading, in another file or this one |
| `[x](canvas:scratch/notes.md)`        | A scratch file                           |
| `[x](#frame=<id>)`                    | A frame; add `&lines=10-20`, `&path=…` or `&comment=<id>` |

Agents are told how to link, and [`view_board`](/docs/board-tools) gives them frame ids.

## Frames

- **Add** a frame from the toolbar: **Agent**, **Files**, **Browser**, **Terminal**, **Drawing**.
- **Move** it by its header, **resize** it from its bottom-right corner.
- **Rename** it by clicking its title in the header.
- **Remove** it with the **×** in its header.

## Layout

Frames that sit close together form a **cluster**: frames within 48 px of each other, and of
each other's neighbours. Inside a cluster, frames whose top edges line up form a **row**, and the
frames of a row share a height.

- **Dropping** a frame near another snaps it into that row, or into a new row above or below. A
  dashed outline shows where it lands. Dropped **between** two frames of a row, or between two
  rows, it goes in between and the others make room: a dotted line marks the gap it goes into.
- **Moving or removing** a frame closes the gap it leaves: the frames after it in its row move
  left, or, if it was alone in its row, the rows below move up.
- **Resizing** a frame's height resizes its row, and moves the rows below.
- **Hold Alt** while dragging or resizing to place a frame freely.
- **Hold Shift** while dragging to move the frame's whole cluster, as it is.

![Dragging a frame near another: the dashed outline shows where it snaps](./screenshots/snap.webp)

Agents use the same rules: they name frames and sides, never coordinates
([Board tools](/docs/board-tools)).

## Presence

- Everyone's **pointer** shows with their name; the host's is marked **host**.
- Someone **out of view** shows as a marker on the edge of the board, in their colour, pointing
  their way: to their pointer, or, while it is off their board, to the middle of what they see.
  Click it to go there.
- **Click someone's avatar** in the top bar to **follow their view**: your board shows what theirs
  shows, framed in their colour, as they pan and zoom. On a screen of another size you see all of
  theirs, and more around it. Panning or zooming yourself lets go, as do **Stop**, their avatar
  again, or their leaving. Following a view is not following a frame's occupant
  ([Focus](/docs/focus)), though the two go together: follow someone's view into the frame they
  occupy and you scroll with them there too.
- **Text selections** in agent threads and files frames show in the selecting person's colour.
- The top bar lists everyone on the board. Your **name** is the field next to it; a new browser
  gets an animal name and a colour.

Presence carries no authority, and goes directly between peers.
