# 19 — Where everyone is

Date: 2026-09-29 · `e2e/drive.ts` `STEP=presence` against an empty board. Host "Karl" and guest
"Ada" (edit access), Chromium via Playwright.

## Question

Pointers show where people are, but only inside your own viewport: once someone works elsewhere on
the board, nothing says where. Can the board point at people out of view, and let you follow
someone's view, as Miro does?

## What was built

- **Views are presence.** Each peer publishes `view`, the board rectangle its viewport shows
  (`viewRect` in `web/lib/viewport.ts`), next to its pointer. It changes on every frame of a pan,
  so it goes out at most every 100 ms (trailing, so the last one always goes); whoever reads it
  eases over the gap. A rectangle rather than the transform: screens differ in size.
- **`useBoardViewport` tells about changes** (`subscribe`, `screen`): transform and size. Until
  now only the zoom re-rendered React; pointers move with the board for free, being in board
  space, but an edge marker lives in screen space and must move with every pan.
- **Markers on the edge** (`PeerMarkers` in `components/board.tsx`): for a peer out of view, a
  chip in their colour on the line from the centre of the viewport to them, clamped to the
  viewport inset (`edgeMarker`), with an arrow their way. The inset keeps it off the toolbar and
  the zoom controls. It points at their pointer, or, while it is off their board (the pointer is
  null then), the middle of their view — so someone reading, mouse away, still shows. A click
  centres the view on that point, keeping the zoom.
- **A pointer that stays put moves on the board when the board moves.** It was published on
  `pointermove` only, so panning with the wheel left it where the mouse had been: a cursor, and
  now a marker, pointing at the wrong place. It is published again on every viewport change while
  the mouse is on the board.
- **Following a view** (`hooks/use-follow-view.ts`): clicking an avatar in the top bar makes our
  viewport show theirs — all of their rectangle, centred, at whatever scale fits (`fitView`), so
  a smaller screen than theirs zooms out rather than cropping. The board gets a border in their
  colour and a "Following Ada · Stop" pill.
  - **Our own moves let go.** `useBoardViewport` tells its own moves (wheel, drag, pinch, zoom
    buttons, fit, a link, a marker) from followed ones: only `follow` applies a transform without
    telling `onOwnMove`. Scrolling inside a frame never moves the board, so it doesn't let go.
  - **Followed moves ease.** Views arrive every 100 ms; the canvas and the dot grid get a 100 ms
    linear transition for followed moves only, so ours stay instant.
  - Their leaving, Stop, or their avatar again let go too.
- **Two kinds of following.** Frame focus (finding 08) already calls scrolling with a frame's
  occupant "following". The two are independent and stack: follow Ada's view into the frame she
  occupies and you scroll with her too. The docs say "follow a view" for the new one.

## Evidence

`STEP=presence` — all checks pass:

- Ada's mouse is on her board, in Karl's view: no marker. Karl pans 3000 px right: her marker sits
  on his left edge, level with her pointer.
- Ada moves her mouse into the top bar: the marker stays, now for the middle of her view.
- Ada pans 8000 px down: her marker moves to Karl's bottom edge.
- Ada wheels 600 px down with her mouse on the board: her pointer moves 600 px on the board.
- Karl clicks her marker: his view centres there, Ada is in view, the marker goes.
- Karl clicks Ada's avatar: his board is framed in her colour and shows what hers shows. She pans
  and zooms (wheel, then Zoom in twice): his view is hers, to the pixel.
- Ada's window shrinks to 900×700: Karl's view is centred on hers and holds all of it.
- Karl pans: he lets go, and stays put when Ada pans on. His zoom buttons and a middle-button drag
  let go too, and so do Stop and her avatar again.
- Ada closes her tab: Karl no longer follows anyone.
