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
