---
title: Glossary
description: The terms these docs use, and what each one means.
section: Technical
order: 5
---

| Term              | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| **agent frame**   | A frame running one coding-agent session. [Agent](/docs/agent)              |
| **agent settings**| An agent session's model, reasoning effort, mode and so on, as the agent offers them |
| **approval**      | The host's yes or no to something an edit guest wants to run. [Guests](/docs/guests#approvals) |
| **board**         | The shared surface all frames live on. One per project                      |
| **board tools**   | `view_board`, `open_frame`, `update_frame`, `close_frame`, `read_board_file`, `write_board_file`: how agents change the board. [Board tools](/docs/board-tools) |
| **browser frame** | A frame showing a URL, loaded by each viewer's browser. [Browser](/docs/browser) |
| **`canvas serve`**| The local server on the host's machine. [CLI](/docs/cli)                   |
| **cluster**       | Frames within 48 px of each other. [Board](/docs/board#layout)              |
| **file list**     | Files an agent picked for a files frame's tree, at display paths it chose. [Files](/docs/files#lists) |
| **files frame**   | A frame showing one project file, read-only and live. [Files](/docs/files)  |
| **follow**        | Scrolling with a frame's occupant. [Focus](/docs/focus)                     |
| **frame**         | One thing on the board: an agent, a file, a terminal or a browser           |
| **guest**         | Anyone on the board who opened the guest link                               |
| **guest access**  | What guests may do, set by the host per board: view, edit or trusted        |
| **guest link**    | The link that joins a board as a guest. Safe to share with the people you invite |
| **host**          | The person who runs `canvas serve` and opens the host link                  |
| **host link**     | The link `canvas serve` prints. Controls the machine: never share it        |
| **occupant**      | The person or agent holding a frame. [Focus](/docs/focus)                   |
| **permission**    | An agent asking before a tool call. Only the host answers                   |
| **prompt draft**  | The shared composer of an agent frame, written by several people at once    |
| **row**           | Frames in a cluster whose top edges line up; they share a height            |
| **scratch file**  | A file an agent wrote for the board only, kept in `.canvas/scratch/`, shown as `canvas:scratch/<name>`. [Board tools](/docs/board-tools#scratch-files) |
| **shared set**    | The files `canvas serve` lets out. [Security](/docs/security#the-shared-set) |
| **terminal frame**| A shell on the host's machine. [Terminal](/docs/terminal)                   |
| **web app**       | The browser UI at `ui.canvas.frebreco.de`                                   |
