# 08 — Frame focus: occupants drive a frame's scroll

Date: 2026-09-26 · `e2e/drive.ts` `STEP=focus|focus-agent` against a scratch repo with a long
`src/big.ts` and a long `docs/notes.md`. Host "Karl" and guest "Ada" (edit access) in separate
browsers; Claude Code on its default model (Haiku 4.5).

## The problem

Everyone could act on every frame at once, and agents now can too (ADR 0003), but nothing showed
who was working where. Scroll was each viewer's own, so "look at this" meant saying where.

## What was built

- **Occupancy is presence** (`src/web/lib/focus.ts`). Each person has at most one `focus`
  (frame, claim time, scroll). Pressing a free frame claims it. Pressing a frame someone else
  holds, or the empty board, gives up yours. The earlier claim wins (ties: lower Yjs client id),
  and a claim that lost clears itself. It lives in awareness, not the board doc: it goes away
  with whoever made it, like cursors (ADR 0001, mesh for presence).
- **Agents occupy the frame they last opened or changed**, until their turn ends
  (`runBoardTool` reports the frame, and the host publishes `agents` claims in its presence). A
  person beats an agent: pressing an agent's frame takes it, and the host drops the claim.
- **The frame shows its occupant**: an avatar in the header (a bot for agents, in a colour from
  the session id) and a ring in their colour.
- **Scroll follows the occupant** (`hooks/use-follow-scroll.ts`): the occupant publishes
  `{ key, top, end }` on every scroll (rAF-throttled). Followers apply it when `key` names the
  same view (`thread`, `source:<path>`, `preview:<path>`, `term`) and re-apply when their own
  content changes. `end` keeps a follower at their own bottom as a thread streams. Covered: agent
  threads, file source (virtualized) and markdown preview, terminals (in lines, via xterm's
  API). Browser frames (cross-origin) and the file tree keep their own scroll (the tree follows
  since finding 18).
- **Detaching is local**: a wheel, touch, scroll key or scrollbar press in a followed frame stops
  following there, for that viewer only. The ring goes and the avatar fades. Clicking the avatar
  follows again. Detachment is tied to the occupant: a new occupant is followed again.

## Evidence

`STEP=focus` — all 16 checks pass:

- Karl presses A: he occupies it, and Ada sees him there, following. Karl scrolls 1600 px and
  Ada's A is at 1600.
- Ada presses A: it stays Karl's. She scrolls and is detached; Karl scrolls on (3200) while she
  stays at her 1000. She clicks his avatar and is back at 3200.
- Ada presses B (markdown preview): Karl sees her there and follows her to 900.
- Karl presses B (taken): he holds nothing, so A is free. Ada presses the board: B is free.
- An agent claim on A shows as `agent` to Ada. She presses A and takes it; the host's claim is
  gone.
- Terminal: `seq 1 400`, Karl scrolls up (first row 383 → 352), and Ada's first row is 352.

`STEP=focus-agent` — Claude Code asked to open `src/big.ts` at 400-410 and explain it. While it
worked, Ada saw `claude-1` occupying the new file frame. When its turn ended, the claim was gone.
Karl then pressed the agent frame and scrolled its thread up, and Ada's thread followed (77 of
557).

## Notes and limits

- Pixel offsets line up because frame sizes are shared and zoom is a CSS scale. If fonts ever
  differ between viewers, anchoring to blocks the way selections do (`selection.ts`) is the
  upgrade.
- Claim times are wall clocks: skew only matters in a genuine race, and then both sides settle
  on the same winner.
- View-only guests can occupy frames too: it is presence, and it moves nobody's content.
