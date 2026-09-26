# 10 — Scratch files and file lists, validated

Date: 2026-09-26 · `e2e/drive.ts` `STEP=scratch` against a copy of the shop repo of finding 07
(`src/auth/{session,password}.ts`, `src/routes/login.ts`, an ignored `.env`), committed so `git
status` starts clean. Host "Karl" and guest "Ada" (edit access) in separate browsers (Chromium via
Playwright). Claude Code on Haiku 4.5, then opencode on its default model, on the same board, one after
the other. Decision: ADR 0005.

## Scratch files

### What was built

- `src/server/scratch.ts`: `.canvas/scratch/`, one flat namespace. `create` never takes a name
  twice (`overview.md` → `overview-2.md`), `write` only overwrites what exists, names are one
  plain segment, so nothing else in `.canvas/` is reachable. 1 MiB cap.
- `Files` reads `canvas:scratch/…` paths from there, lists them in the tree after the shared set,
  and re-sends one when it is written (the watcher skips `.canvas/`).
- `board-mcp.ts`: `content` + `name` on `open_frame` / `update_frame` become a scratch file
  before the call is relayed, and the browser gets only its path. If the board refuses the call,
  the new file is removed again. `read_board_file` and `write_board_file` are answered on the
  server, without the board. `view_board` lists the scratch files.
- The priming says what scratch files are for, and that temp files for the agent's own work go
  wherever they would without canvas.

### Evidence (`STEP=scratch`, all checks pass for both agents)

Prompt 1: _"On the board, show us a short markdown write-up of how login works in this project,
and a small HTML page that visualises the login flow as boxes and arrows."_ Prompt 2: _"Add a
section "Open questions" with one question to the write-up at <its path>."_

|                        | Claude Code                                                              | opencode                                                                        |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| prompt 1               | `view_board`, reads, 2× `write_board_file`, `open_frame` for each        | `view_board`, `read_board_file` ×2 (Claude's files), 2× `write_board_file` (overwrote them), 2× `open_frame` |
| files                  | `login-overview.md`, `login-flow-diagram.html`                           | the same two, overwritten                                                        |
| detour                 | tried the HTML as a _browser_ frame first, then a file frame             | none                                                                            |
| prompt 2               | `read_board_file`, `write_board_file`                                    | same                                                                            |
| project (`git status`) | clean                                                                    | clean                                                                           |
| board doc              | 459 bytes: paths, no content                                             | 456 bytes                                                                       |
| guest                  | both render (markdown; HTML with its script-drawn arrows); the rewrite shows live, in the same frame | same                                       |

- Neither agent wrote a temp file into the project. Both preferred `write_board_file` and then
  `open_frame` with the path over passing `content` to `open_frame`.
- opencode found Claude's files through `view_board` and rewrote them instead of creating
  `-2` copies: reuse across agents works without being asked.
- Claude's browser-frame detour: the error for a non-http URL now points at file frames.

## File lists

### What was built

- File frames carry `files`: `{display, path, lines?}` entries (`web/lib/board.ts`).
  `web/lib/file-list.ts` checks display paths (no empty, `.` or `..` segments; unique; none a
  folder of another), orders the tree by the list (a folder sorts at its first entry), and finds
  the entry a frame shows from its path and lines.
- `open_frame` / `update_frame` take `files`. `canvas serve` checks each entry's path against the
  shared set and turns entry `content` into scratch files (a name from the display path if none
  is given). The browser stores the list, and shows its first entry unless told otherwise. A new
  list moves the frame off a file no longer on it; `[]` removes the list. `view_board` spells each
  list out, display → real path.
- `FileTree` shows either the shared set or a list: the agent's order, all folders open, lines and
  "scratch" as row badges, read-only for `view` guests (a click snaps back). The frame's
  "all files" toggle is per viewer and selects the real path. Picking a list entry keeps the
  frame's title.
- `@pierre/trees` finds `initialExpandedPaths` by binary search in its default order, so under a
  custom `sort` it misses folders. A list's folders are expanded through their handles after
  every reset.

### Evidence (`STEP=lists`, all 18 checks pass for both agents)

Prompt: _"Show us everything about login in this project in one file frame we can click
through: a short write-up first, then the relevant source files grouped in folders by layer, at
the relevant lines, and a small HTML visualisation of the flow last."_

- **One call, one frame.** Both agents made a single `open_frame` with the whole list, write-up
  content inline, and opened no frame per file.
- **opencode** (with `IDLE_MS`: it first sent an explore subagent, which took over 4 min):
  `1 Write-up.md`, `2 HTTP routes/{login,products}.ts`, `3 Auth/{session,password}.ts`,
  `4 Data/db.ts`, `5 Flow diagram.html`, every repo file with lines. It overwrote its earlier
  scratch copies instead of adding a fourth.
- **Claude Code** (Haiku 4.5), three runs: `📋 Login Overview`, `Routes/HTTP`,
  `Auth/{Sessions,Password}`, `🎨 Flow Diagram`, with lines, in two runs; once a flat list without
  lines. Display names without extensions lose their file icons (the tree picks icons by name).
- Host and guest see the list in the agent's order; lines show as badges ("L5–15"). A list with
  folders written straight into the board opens every folder, in the list's order.
- The guest picks an entry → the frame shows the real file at the entry's lines for everyone,
  the host's list selects it too, and the title stays.
- The guest switches to all files → `src/routes/login.ts` is selected where it lives; the host
  still sees the list.
- Access `view` → the guest still sees the list; clicking another entry changes nothing and the
  selection snaps back; no all-files toggle.
- The project stays clean throughout.
