# 0012. Agent sessions are the board's; an agent frame shows one

## Status

Proposed, 2026-10-03 (#37, epic #32). Amends ADR 0003: the frame an agent acts as (decision 1),
and when an agent process starts (consequences). Builds on ADR 0011's roles.

## Context

An agent frame and its session are one thing today: the session's id is the frame's id. That id
names the session's log (`.canvas/sessions/<id>.ndjson`), its MCP server (`/mcp/<id>`), the
agent's own frame in the board tools ("you are frame [id]"), its focus claims and the requests
that prompt it. Starting over means a new frame, which loses its place, size and title.

Where this should go, beyond the first step:

- **Sessions are the board's.** Every conversation that ran on the board can be listed from one
  place. Each knows the frame it ran in, and a frame lists its own by default.
- **A frame switches between conversations,** later from a sidebar like the file frame's tree,
  also while one is still running. Several frames may show the same conversation, streaming.
- **Showing a conversation is a view.** Anyone who can change the board can switch a frame to
  another conversation. Starting agent processes stays behind the roles of ADR 0011.

Two histories are involved. canvas's log is what the thread shows. The agent keeps its own
(Claude Code under `~/.claude/`, opencode in its database), and that is what the model remembers.
`acpSessionId` links them: a conversation shown again from canvas's log continues by reattaching
the agent's, with `session/resume` or `session/load`.

## Decision

1. **A session is a conversation; a frame shows one.** Session ids are their own, no longer
   frame ids. An agent frame names the session it shows in the board doc (`session`); without
   one, it shows the session with its own id. So boards from before, and new frames' first
   conversations, need no migration. Switching is writing that field: shared, like everything a
   frame shows (ADR 0007), and allowed to whoever may edit the board.
2. **Sessions are kept by `canvas serve`, for the whole board.** Not in the doc: they are the
   machine's state. A session's meta says where it began (`frameId`), when it began and was last
   active, and its title (its first prompt, shortened). That is enough to list them, for a frame
   or for the board, without any log. A frame's list is the sessions that began in it. Removing a
   frame removes none of its sessions.
3. **Each turn says which frame it was sent from, and the agent acts as that frame.** The `turn`
   event carries `frameId`. The board tools' "you" is the frame of the running turn, not the
   session: with several frames on one session, it is the one the person typed in. `canvas
   serve` puts that frame into each `board-call`. Focus claims and the "needs you" pointer follow
   it; a waiting session shown in no frame points at the frame of its turn.
4. **A new conversation is only an id until its first prompt.** "New conversation" writes a fresh
   id into the frame, and the settings it starts with (copied from the conversation before) into
   the frame too. `canvas serve` hears nothing: no log, no process. The first prompt starts the
   session, with the frame's agent and those settings, and it is a request like any prompt: an
   `edit` member's waits for the host's approval. So clicking "new" costs nothing and runs
   nothing, and conversations nobody prompted leave no trace.
5. **An agent process runs for a prompt, not for a frame.** The host's browser no longer starts a
   session for every agent frame it sees. To show the settings before any process runs, `canvas
   serve` keeps the settings each kind of agent offered last (`.canvas/agents.json`), and when it
   knows none yet, it starts that agent once to list them and stops it. A session's process
   still stops after a while idle; switching away from an idle session stops it at once
   (`session/close` where the agent offers it). A session comes back with `session/resume` where
   the agent offers it (no replay), else `session/load`.
6. **Logs are loaded when shown.** Joining, a browser gets the head of every session (meta and
   settings), and the logs of the sessions frames show; any other log when a frame switches to it.
   For the host's browser as for guests: the list of a board's sessions only grows.

## Consequences

- One frame, many conversations; one conversation, possibly many frames. Each frame keeps its own
  shared draft (`prompt:<frameId>`), which survives switching.
- A guest with `edit` access can switch frames and start empty conversations freely. Only
  prompts start processes, and they are approved as before. Today, picking an agent in a frame
  starts its process unasked (ADR 0003's consequences); it no longer does.
- A conversation may keep running while its frame shows another. The first version doesn't allow
  switching away from a busy one, but nothing here depends on that.
- Agents act as the frame they were prompted from. If that frame is closed mid-turn, their board
  tools say so, as they do today.
- `canvas serve` still holds every session's log in memory, as today. Loading on demand is for
  the browsers; the server's turn comes with more sessions.

## Open

- The board-wide list of sessions, and opening one in a frame it didn't begin in.
- A frame's list as "began here" or "ever prompted from here" (the turns know both).
- Another kind of agent in a new conversation of the same frame (sessions know their kind).
- Sessions the agent has but canvas never saw (`session/list`): no canvas log to show.
- How many processes may run at once, when conversations run in the background.
