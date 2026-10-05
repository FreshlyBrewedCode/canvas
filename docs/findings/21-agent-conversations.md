# 21 — Agent conversations

Date: 2026-10-03 · `e2e/tests/agent-sessions.spec.ts`, recorded with opencode 1.18.31, and a
manual check in Chromium. Host "Karl" and guest "Ada" (edit access, then view). Issue #37 (epic
#32), ADR 0012.

## Question

An agent frame was its session: the session's id was the frame's. Starting over meant a new
frame, losing its place, size and title, and an old conversation could not be shown again. Can a
frame start a new conversation and go back to its earlier ones, for everyone, with the agent
still remembering them, and without a process for every conversation ever begun?

## What was built

- **Sessions are `canvas serve`'s, for the board** (`server/agents.ts`). A session's meta says
  where it began (`frameId`), when it began and was last active, and its title (the first prompt,
  shortened); old logs get it from their events (`frameId` = the session id). `welcome` carries
  every session's head (meta and settings, no events); a log comes with `session-open` when a
  frame shows it.
- **A frame shows one** (`session` in the board doc, `shownSession` in `web/lib/board.ts`; without
  one, its own id's: no migration). `newConversation` writes a fresh id and the settings it starts
  with (`settings`, copied from the conversation shown); `showConversation` writes another id.
  Both are board changes, so the host and edit members make them, without approval. The frame's
  draft (`prompt:<frameId>`) is the frame's and stays.
- **The turn's frame is the agent's "you".** `turn` events carry `frameId`, and `canvas serve`
  puts the running turn's frame into each `board-call`; focus claims and "needs you" follow it.
  The board MCP instructions no longer name a frame (they went stale as soon as a session could be
  shown elsewhere): they say the agent is in the frame its latest prompt came from, and that
  `view_board` marks it.
- **No process until the first prompt, or a settings change before it.** `agent-create` is gone;
  `agent-prompt` begins a session that doesn't exist yet. A settings change begins it too: only
  the agent knows which settings follow a change (effort depends on the model, opencode's options
  per model), so the ADR's "first prompt" became "first prompt or settings change". Both are
  requests, approved as before.
- **Settings before any process** (`.canvas/agents.json`): the settings each kind offered a new
  session last. When none are known, `kind-probe` starts that agent once, reads `session/new`'s
  options and stops it.
- **Processes for prompts, not frames.** An idle session no frame shows is released at once
  (`agent-release`: `session/close` where offered, then the process is killed); a busy one when
  its turn ends, unless a frame shows it again by then (`Releases`, `web/lib/sessions.ts`). The
  next prompt brings it back with `session/resume` where offered, else `session/load`.
- **The conversation menu** (`components/conversation-menu.tsx`): the agent's name in the header
  opens New conversation and the frame's conversations (`conversations` in `web/lib/sessions.ts`:
  those that began in it, plus the shown one; never-prompted ones only when shown). Disabled
  while the shown one runs or waits, a list only for read-only viewers. An empty new conversation
  links back to the one before (`backTo`).
- **Guests read any log.** A guest asks the host for the log of a session a frame came to show
  (`session-open` as a read): any admitted member, view too; not through approvals. Live
  `agent-event`s carry their index in the log, so a guest that missed some asks again and logs
  converge whatever order things arrive in.

## Evidence

- **Both agents offer resume and close.** From `initialize` in the recordings:
  `@agentclientprotocol/claude-agent-acp` 0.81.2 advertises `loadSession` and
  `sessionCapabilities` `close`, `delete`, `fork`, `list`, `resume`; opencode 1.18.31
  `loadSession` and `close`, `fork`, `list`, `resume`. So canvas never falls back to
  `session/load` with these two; the fallback is tested against a stand-in agent
  (`agents.test.ts`).
- **Resume, not load.** `session/load` replays the whole conversation as `session/update`s, which
  canvas drops (they come while no turn is open; its own log is what the thread shows).
  `session/resume` reattaches without a replay: the right one for a log canvas already has. An
  agent with neither, or one that no longer knows the session, gets a new one: the thread is
  still there, the agent's memory of it isn't.
- **The agent remembers across a release.** In the recording of `agent-sessions`, opencode-1 is
  told "Remember the word marmalade" and gets `session/close` when the frame switches away;
  opencode-2, a new process, starts with `session/resume` and answers "marmalade" to "Which word
  did I ask you to remember?". That is the real agent's memory; a replay only plays it back.
- **The probe** is a process like any other: `session/new`, then `session/close`, no prompt. With
  `.canvas/agents.json` present it doesn't run again.
- **Cassettes follow processes, not frames.** Processes take recordings per kind in the order
  they start (`e2e/acp/cassette.ts`): `<kind>-0` is now the probe, and every time a conversation
  comes back after a release it is another process and another cassette, starting with
  `session/resume` (`cassette.ts` hands MCP servers through it, as through `session/new`). A test
  that switches records more files, and replays only if it releases and resumes in the same
  order. All agent cassettes were re-recorded for layer 1.

## Validated

- `e2e/tests/agent-sessions.spec.ts`, "new conversations in a frame, and back", with Ada an edit
  guest, recorded with real opencode, then replayed (four runs, all pass) and in the full suite:
  - while the first turn runs, New conversation is disabled and the menu says "Stop the agent to
    switch.";
  - New conversation empties the thread for both, keeps the settings chip's text and the draft,
    shows the new one checked and the old one by its title;
  - the empty thread's "← back to" switches back, for both;
  - Ada's New conversation switches Karl's frame; `canvas serve` has no new session and
    `.canvas/sessions/` no new log, and no agent starts; Ada picks the old one from the menu;
  - back in it, the agent answers the word from before the switches (above);
  - made a view member, Ada's menu is a list only.
- Layer 3's manual check in Chromium with live opencode, host and guest: the same, plus ↑ after
  switching recalls the shown conversation's prompts, and a prompt in a new conversation lists
  both with their titles.
- Not validated end to end: Claude Code in a switching frame (the unit tests and the
  capabilities say it works the same; the e2e uses opencode), several frames showing one
  conversation, and a guest asking for a log the host had not loaded.

## Open

- The board-wide list of sessions, and opening one in a frame it didn't begin in: the queries
  (`boardSessions`, `framesShowing`) exist, the UI doesn't.
- A sidebar for a frame's conversations, like the file frame's tree, instead of the menu.
- Conversations running in the background: switching away from a busy one is refused today, though
  release already waits for the turn's end.
- How many processes may run at once once they do.
- A turn count per conversation in the menu: heads don't carry it, and other logs aren't loaded.
- ↑ in the draft goes through the shown conversation's prompts only, not the frame's others.
- The priming no longer names a frame; an agent that wants to know where it is calls `view_board`.
  If agents act as the wrong frame in practice, the fix is per-turn context (the prompt naming its
  frame), still never a replaced system prompt (finding 06).
