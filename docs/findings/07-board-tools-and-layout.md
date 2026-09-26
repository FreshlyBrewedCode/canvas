# 07 — Board tools and layout, validated

Date: 2026-09-26 · `e2e/drive.ts` `STEP=tools|lines|layout|resume` against a scratch shop repo
(`src/auth/{session,password}.ts`, `src/routes/login.ts`, a README, a long `src/big.ts`, an
ignored `.env`). Host "Karl" and guest "Ada" (edit access) in separate browsers. Claude Code on
the account's default model (Haiku 4.5, Manual mode), opencode on Big Pickle (build mode).
Decision: ADR 0003.

## What was built

- `src/shared/layout.ts` — clusters (frames within 48 px, transitively) and rows (top edges
  within 16 px) read off positions; `placeNew`, `placeNear`, `moveFrame`, `lift`, `resizeInRow`
  return patches that make room inside the cluster only. Positions stay the only board state.
- `src/shared/board-tools.ts` — the four tools and the priming; `src/server/board-mcp.ts` — the
  per-session MCP endpoint and relay; `src/web/lib/board-tools.ts` — the tools run against the
  board doc in the host's browser.
- File frames carry `lines` (opened, scrolled to and highlighted for everyone) and `origin`.
- Dragging snaps into rows or new rows with a dashed preview; resizing keeps a row's height;
  Alt opts out.

## Agents using the tools (`STEP=tools`)

Board: the agent's frame at the origin, a README frame in its own cluster 3000 px away.
Prompt 1: _"Show me the files relevant to authentication in this project on the board, at the
relevant lines."_ Prompt 2: _"Open src/auth/password.ts at the lines of the function that
verifies a password; close the login.ts frame; and open a terminal in a new row below your
frame."_

|                    | Claude Code                                                                                             | opencode                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| found the files by | `git ls-files` / `find` (asked permission), reads                                                       | search, reads                                                                                               |
| prompt 1           | `view_board`, 2–3× `open_frame`                                                                         | `view_board`, 3× `open_frame` with line ranges                                                              |
| placement          | end of its row, one after another, at its height                                                        | same                                                                                                        |
| README cluster     | untouched                                                                                               | untouched                                                                                                   |
| prompt 2           | `open_frame` password.ts L12-16 (a duplicate, in one run), `close_frame`, `open_frame` terminal `below` | `update_frame` password.ts → L12-16 (reused), `close_frame`, `open_frame` terminal `next_to` itself `below` |
| after close        | row closes the gap                                                                                      | row closes the gap                                                                                          |
| permission asks    | only the shell commands                                                                                 | none                                                                                                        |
| guest              | sees every frame as it opens                                                                            | same                                                                                                        |

- Both agents followed the priming: look first, place in their own cluster, no pixel talk.
  opencode retargeted a frame instead of duplicating it; Claude on Haiku opened a second
  password.ts frame once. The priming asks for reuse; a stronger model or a sharper line may be
  needed.
- The thread shows board calls as `canvas · open_frame` etc. Tool rows are named by ACP kind
  (`other`) and `@tanstack/ai-acp` only passes the call's title as its args, so the actual
  arguments of _any_ tool call don't reach the thread (true before this change too).
- After a `canvas serve` restart (new MCP secret), both a reloaded opencode session and a rebuilt
  Claude session answered `view_board` correctly (`STEP=resume`: "4 frames in 2 rows").

## Line ranges (`STEP=lines`)

A file frame on `src/big.ts` (≈730 lines) with `lines: 400–412`: host and guest both open with
line 400 at 58 px from the top (3 lines of context), 400–412 highlighted in the status colour
with a gutter bar. Scrolling is by line height, then corrected against the rendered line.

## Layout by mouse (`STEP=layout`)

| action                                   | result                                                  |
| ---------------------------------------- | ------------------------------------------------------- |
| drop B right of A (40 px off, 30 px low) | preview shown; B at A.x+A.w+24, A.y, A's height         |
| drop C under A                           | preview shown; C at A.x, A.bottom+24                    |
| resize A +100 px tall                    | B's height follows; C's row moves down by 100           |
| drop C left of A                         | row reorders: C, A, B at 0 / 624 / 1248, all one height |
| Alt-drag B                               | no preview; lands exactly where dropped                 |

## Open

- Pushing into a neighbouring cluster is avoided only for agent placement (`placeNear` falls
  back to a new row, then below the cluster). A person's drop, or a row growing, can still run
  into another cluster and merge with it.
- Rows only: no stacks inside a column yet.
- Agent-opened frames are recorded (`origin`) but not shown differently on the board.
- The tools see what frames _are_, not what they show (terminal output, other agents' threads).
