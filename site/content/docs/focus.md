---
title: Focus
description: Frame occupants, and following their scroll.
section: Features
order: 8
---

Each person occupies at most one frame. The frame's **occupant** shows as an avatar in its header,
and whoever follows them sees it ringed in the occupant's colour. Followers scroll with the
occupant: "look at this" needs no line numbers.

![Ada occupies login.ts: Ada's avatar is in the header, and Karl, following, sees the frame ringed in Ada's colour](./screenshots/files-lines.webp)

## Occupy a frame

- **Press** a free frame to occupy it. Going to a frame in [full screen](/docs/board#full-screen)
  occupies it too.
- Pressing a frame someone else occupies, or the empty board, frees yours.
- If two people press the same frame at once, the earlier one keeps it.

## Follow

While you follow a frame's occupant, its content scrolls with theirs: agent threads, source and
preview in files frames, and terminal scrollback. Browser frames keep their own scroll.

A files frame's tree follows too: whether it is open and how wide, list or all files, which folders
are open, the search, and its scroll.

- **Scrolling yourself** stops following, for you only. So does doing anything in the tree:
  opening a folder, searching, hiding it. The ring goes, and the avatar fades.
- **Click the avatar** to follow again.
- A new occupant is followed again.

## Agents

An agent occupies the frame it last opened or changed through the [board
tools](/docs/board-tools), until its turn ends. Its avatar is a bot icon. A person pressing that
frame takes it over.

Occupancy is presence: it goes with the person who holds it, like their pointer.

## Full screen

Someone in full screen shows on the header of the frame they are on, as a chip with their name,
and, if you are in full screen on the same row, as a ring in their colour around its dot in the
top bar. Following their view takes you into full screen with them
([Presence](/docs/board#presence)).
