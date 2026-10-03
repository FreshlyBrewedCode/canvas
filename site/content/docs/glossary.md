---
title: Glossary
description: The terms these docs use, and what each one means.
section: Technical
order: 7
---

| Term              | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| **agent frame**   | A frame running one coding-agent session. [Agent](/docs/agent)              |
| **agent settings**| An agent session's model, reasoning effort, mode and so on, as the agent offers them |
| **approval**      | The host's yes or no to something an edit guest wants to run. [Guests](/docs/guests#approvals) |
| **board**         | The shared surface all frames live on. One per project                      |
| **board tools**   | `view_board`, `view_frame`, `open_frame`, `update_frame`, `close_frame`, `read_board_file`, `write_board_file`, `add_comment`, `edit_comment`, `delete_comment`, `draw`: how agents see and change the board. [Board tools](/docs/board-tools) |
| **canvas relay**  | A server you run that carries a board's traffic where browsers can't connect directly. [Relay](/docs/relay) |
| **browser frame** | A frame showing a URL, loaded by each viewer's browser. [Browser](/docs/browser) |
| **`canvas serve`**| The local server on the host's machine. [CLI](/docs/cli)                   |
| **cluster**       | A group of rows of frames, in a line with others; it can have a name. [Board](/docs/board#layout) |
| **column**        | One place in a row, as wide as its frame. [Board](/docs/board#layout)       |
| **code tour**     | A files frame an agent makes to walk through code: a guide, then the files at their lines. [Skills](/docs/skills#code-tour) |
| **comment**       | A markdown note on lines of a file, kept by the files frame it was written in. [Files](/docs/files#comments) |
| **drawing frame** | An Excalidraw whiteboard everyone draws on, agents included. [Drawing](/docs/drawing) |
| **file list**     | Files an agent picked for a files frame's tree, at display paths it chose. [Files](/docs/files#lists) |
| **files frame**   | A frame showing one project file, read-only and live. [Files](/docs/files)  |
| **fingerprint**   | A short code, like `ab12 cd34`, for one browser's key; the host verifies it as people join. [Board](/docs/board#presence) |
| **follow**        | Scrolling with a frame's occupant. [Focus](/docs/focus)                     |
| **follow a view** | Your board showing what someone else's shows, until you pan or zoom. [Board](/docs/board#presence) |
| **frame**         | One thing on the board: an agent, a file, a terminal, a browser or a drawing |
| **full screen**   | Your own view of one row at 100%, its frames as tall as your screen. [Board](/docs/board#full-screen) |
| **guest**         | Anyone on the board who opened the guest link                               |
| **guest link**    | The invite to a board: whoever opens it knocks, and the host lets them in. Share it with the people you invite; **Reset invite link** retires it. [Guests](/docs/guests#reset-invite-link) |
| **issuer key**    | A name and secret a relay's operator gives a host or team; `canvas serve` signs relay tokens with it. [Relay](/docs/relay) |
| **line**          | Clusters side by side, left to right, tops aligned; lines go top to bottom. [Board](/docs/board#layout) |
| **lobby**         | Where someone who opened the guest link waits until the host lets them in. [Guests](/docs/guests#the-lobby) |
| **link**          | A markdown or HTML link to a place on the board: a frame, a file, lines, a heading, a comment. [Board](/docs/board#links) |
| **host**          | The person who runs `canvas serve` and opens the host link                  |
| **host link**     | The link `canvas serve` prints. Opens the board as host in a paired browser; keep it to yourself |
| **member**        | A browser the host let in, by its fingerprint, with a role. [Guests](/docs/guests#members-and-roles) |
| **occupant**      | The person or agent holding a frame. [Focus](/docs/focus)                   |
| **outdated comment** | A comment whose lines are gone from the file. It shows above the first line, with what they read. [Files](/docs/files#comments) |
| **pairing code**  | A one-time code in the host link, good for 10 minutes: the first browser to open the link is paired with `canvas serve` as the host. `canvas pair` prints a new one. [Quick start](/docs/quick-start#2-open-the-host-link) |
| **permission**    | An agent asking before a tool call. Only the host answers                   |
| **prompt draft**  | The shared composer of an agent frame, written by several people at once    |
| **relay token**   | Admits one board to a canvas relay for 30 days; the host's tab and guest links carry one. [Relay](/docs/relay) |
| **role**          | What a member may do, set by the host per member: view or edit. [Guests](/docs/guests#members-and-roles) |
| **row**           | Frames side by side in a cluster, left to right; they share a height. [Board](/docs/board#layout) |
| **scratch file**  | A file an agent wrote for the board only, kept in `.canvas/scratch/`, shown as `canvas:scratch/<name>`. [Board tools](/docs/board-tools#scratch-files) |
| **shared set**    | The files `canvas serve` lets out. [Security](/docs/security#the-shared-set) |
| **signalling relay** | A server through which browsers find each other before they connect directly: public Nostr relays, or a canvas relay. [Connection](/docs/connection) |
| **skill**         | Instructions an agent loads when a request calls for them. canvas gives its own to every agent session. [Skills](/docs/skills) |
| **terminal frame**| A shell on the host's machine. [Terminal](/docs/terminal)                   |
| **trusted**       | A member the host lets run things without approval and type into terminals, until the host's tab reloads. Never saved. [Guests](/docs/guests#trusted-for-this-session) |
| **web app**       | The browser UI at `ui.canvas.frebreco.de`                                   |
