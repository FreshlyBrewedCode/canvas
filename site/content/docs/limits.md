---
title: Limits
description: What canvas does not do, yet.
section: Technical
order: 4
---

canvas is a prototype. These are known, and not bugs to report.

## Hosting

- **The host's browser must be open.** It is the only way to `canvas serve`: without it nothing
  runs, board tools are unavailable, and board edits between guests wait.
- **With several host tabs**, the first one connected runs the board tools.
- **Peer discovery uses public Nostr relays.** Some are down at any time; discovery usually
  succeeds through the others.

## Guests

- **One guest access per board**, no per-person roles.
- **No way to revoke a guest link** except deleting `.canvas/`, which changes every link.
- **Late joiners receive whole threads** in one message. Fine for short sessions.

## Agents

- **Claude Code and opencode** are the agents canvas launches. Others speak ACP too but need code.
- **Permission prompts add up**: opencode asks for every shell command.
- **Tool call arguments** are not shown in the thread, only the tool's title.
- **Agents prompt other agents only through people**: an agent frame an agent opens gets a draft.

## Frames

- **Terminals** do not survive a restart of `canvas serve`, and keep running after their frame is
  removed, until `canvas serve` stops.
- **Browser frames** load pages per viewer: a dev server on the host's `localhost` is not visible
  to guests, who see a notice.
- **HTML previews** are one file: relative assets and links don't load.
- **Files are read-only.** The board cannot create or edit files; agents do.
- **The shared set is fixed by rule.** There is no `.canvasignore` yet.
- **Layout**: only rows, no stacks; a dropped frame can still run into a neighbouring cluster.
