---
title: Terminal
description: Shells on the host's machine, mirrored to everyone.
section: Features
order: 6
---

A terminal frame is a shell on the host's machine, started in the project directory. Everyone sees
its output live.

![A terminal frame running the project's dev server](./screenshots/terminal.webp)

- **Who types**: the host, and members the host [trusts](/docs/guests#trusted-for-this-session)
  for the session. Everyone else reads.
- **Size**: the shell follows the size of the host's frame. In
  [full screen](/docs/board#full-screen) a terminal keeps a height of its own: half the host's
  screen to begin with; drag its bottom edge there to change it. Everyone's full screen shows the
  host's height, so what the shell draws fits for all.
- **Scroll**: whoever occupies the frame drives its scrollback for everyone following
  ([Focus](/docs/focus)).

## Lifetime

- The shell starts when the frame is added, by anyone who can edit the board.
- It keeps running until `canvas serve` stops, even if the frame is removed.
- After a restart of `canvas serve`, the frame starts a new shell. The old output is gone.

A terminal runs as the host's user: whoever types into it can do anything the host can. See
[Security](/docs/security).
