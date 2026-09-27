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
- **One host tab at a time.** Opening the host link again moves the board to the new tab; the
  old one turns read-only until you press **Use here** there.
- **Peer discovery uses public Nostr relays.** Some are down at any time; discovery usually
  succeeds through the others.

## Guests

- **One guest access per board**, no per-person roles.
- **No way to revoke a guest link** except deleting `.canvas/`, which changes every link.
- **Late joiners receive whole threads**, shortest first, each in one message: a very long thread
  takes a while to appear, and closed frames' threads are not sent.

## Agents

- **Claude Code and opencode** are the agents canvas launches. Others speak ACP too but need code.
- **Permission prompts add up**: opencode asks for every shell command.
- **Tool call arguments** are not shown in the thread, only the tool's title.
- **Tool output is cut** to its first 3,000 and last 1,000 characters, and images a tool returns
  (a screenshot the agent reads, a drawing) show as a placeholder. The agent itself gets them in full.
- **Agents prompt other agents only through people**: an agent frame an agent opens gets a draft.

## Frames

- **Terminals** do not survive a restart of `canvas serve`, and keep running after their frame is
  removed, until `canvas serve` stops.
- **Terminals need `setsid`** (util-linux, on every Linux) to be a real terminal for the shell.
  Without it, as on macOS, Ctrl-C does not reach programs, and ones that open the terminal
  themselves — fzf's Ctrl-R, `sudo` and `ssh` prompts — hang.
- **Browser frames** load pages per viewer: a dev server on the host's `localhost` is not visible
  to guests, who see a notice.
- **HTML previews** don't load relative assets (CSS, images, scripts). Their links work.
- **Links to frames** name a frame's id: once it's closed, they go nowhere.
- **Files are read-only.** The board cannot create or edit files; agents do.
- **The shared set is fixed by rule.** There is no `.canvasignore` yet.
- **Layout**: only rows, no stacks; a dropped frame can still run into a neighbouring cluster.
