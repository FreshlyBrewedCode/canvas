---
title: Quick start
description: Serve a project, open the board, invite a guest.
section: Start
order: 2
---

## Requirements

- [Bun](https://bun.sh). canvas is TypeScript and runs on Bun.
- At least one agent, installed and logged in on the host's machine:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code): the `claude` CLI.
  - [opencode](https://opencode.ai): the `opencode` CLI.
- A current browser. canvas is developed and tested in Chromium.

canvas offers the agents it finds on the `PATH`. Guests need nothing but a browser.

## 1. Serve a project

In the project you want to work on:

```bash
bunx @frebreco/canvas serve
```

```
canvas serving /home/you/src/shop

  open the board as host:
  https://ui.canvas.frebreco.de/?room=LEXuANjizGUi#k=…&pk=…&server=ws%3A%2F%2F127.0.0.1%3A4418&token=…

  keep this link to yourself — it controls agents on this machine.
  share the guest link from the board instead.
```

`canvas serve` listens on `127.0.0.1:4418`. It writes its state to `.canvas/` in the project;
add that to your `.gitignore`.

## 2. Open the host link

Open the printed link in a browser on the same machine. The top bar says **connected to canvas
serve**. You are the host.

The host link carries the token that controls `canvas serve`. Never share it.

## 3. Add frames

The toolbar adds frames: **Agent**, **Files**, **Browser**, **Terminal**. Add an agent frame, pick
an agent, write a prompt and press **Send** (⌘/Ctrl-Enter).

## 4. Invite a guest

1. Pick the [guest access](/docs/guests) in the top bar. The default is **edit, I approve runs**.
2. Press **Copy guest link** and send it.

The guest's browser finds the host's peer to peer and shows **host online** once connected.
Anything a guest wants to run on your machine appears as an approval card for you.

![The host's top bar: guest access, and the guest link to copy](./screenshots/topbar-host.webp)

## Restarting

Stop `canvas serve` with Ctrl-C. Started again in the same directory, it keeps the room, so the
links people have keep working, and it restores the board and the agent threads. Terminals start
a new shell.
