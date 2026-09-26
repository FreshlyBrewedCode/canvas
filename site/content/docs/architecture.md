---
title: Architecture
description: The two halves of canvas, and what travels where.
section: Technical
order: 1
---

canvas has two halves: **`canvas serve`**, a local server on the host's machine, and the **web
app**, a static single-page app served from `ui.canvas.frebreco.de`. There is no canvas backend in
between. Each release channel has its own build of the web app, matching its `canvas serve`: a
stable release opens `ui.canvas.frebreco.de`, a pre-release (`@frebreco/canvas@next`) opens
`ui.canvas.frebreco.de/next`. When a page and `canvas serve` are different releases (a tab left
open across a release, or an older CLI), a strip under the top bar says which one to update.

```
guest ──┐
guest ──┼── trystero (WebRTC) ──▶ host's browser ── WebSocket + token ──▶ canvas serve ──┬── agents (ACP)
guest ──┘                                                                                ├── terminals (PTY)
                                                                                         ├── files (read-only)
presence (pointers, selections, focus): every browser to every browser                  └── board tools (MCP)
```

## canvas serve

A [Bun](https://bun.sh) server started in the project directory. It:

- runs **agent sessions** over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP),
  one connection per session, so settings can change at any time;
- runs **terminals** as PTYs in the project directory;
- serves **files** of the [shared set](/docs/security#the-shared-set), read-only, watching them
  for changes;
- gives each agent session an **MCP server** on loopback with the [board tools](/docs/board-tools);
- **persists** the room, the board and the sessions in `.canvas/` (see below).

It speaks to exactly one kind of client: the host's browser, over one WebSocket, authenticated with
the token from the host link. It knows nothing about guests.

## Web app

A React app. It has no server of its own: the host link tells it where `canvas serve` is, and
peers find each other through [trystero](https://github.com/dmotz/trystero), which signals over
public Nostr relays and then connects browsers directly over WebRTC.

## Authority is a star, presence is a mesh

- **The board** is a [Yjs](https://yjs.dev) document. Guests send their board updates to the host
  only; the host applies what the guest's access allows and passes it on.
- **Agent threads, terminal output and open files** exist only on the host's side and are mirrored
  out by the host's browser.
- **Anything that would run** on the host's machine is a request to the host's browser, checked
  against the guest access ([Guests](/docs/guests)).
- **Presence** (pointers, selections, frame focus) goes peer to peer, since it carries no
  authority.

## Agent threads

A session is an append-only log of events: prompts with their author, the agent's output as
[AG-UI](https://docs.ag-ui.com) chunks translated from ACP, permission requests and answers. Every
browser folds the same log with the same code, so everyone renders an identical thread.

## Board tools

When an agent calls a board tool, `canvas serve` relays the call to the host's browser, which runs
it against the board document like a local edit. Paths are checked against the shared set first.
Content for a scratch file stays with `canvas serve`: it writes the file and relays only its path, so
the board document never holds file content.
Layout rules (clusters, rows, placement) are pure geometry over frame positions, shared by the
tools and the mouse.

## Storage

Everything `canvas serve` keeps lives in `<project>/.canvas/`:

| File                    | Holds                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `room.json`             | Room id, room key, the host's key pair, the host token (mode `0600`) |
| `board.bin`             | The latest state of the board                                 |
| `sessions/<id>.ndjson`  | One agent session: its settings and its events                |
| `scratch/<name>`        | Scratch files agents wrote for the board                      |

Keeping `room.json` keeps the links valid across restarts. Delete `.canvas/` to start over with
new links and an empty board.

## Stack

Bun, TypeScript, React 19, Vite, Tailwind v4; `@agentclientprotocol/sdk`, `@tanstack/ai-acp`;
trystero, Yjs, y-protocols awareness, CodeMirror with y-codemirror; xterm.js; `@pierre/trees` and
`@pierre/diffs` for the files frame.
