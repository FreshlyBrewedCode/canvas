# 0003. Agents act on the board as edit guests, through the host's browser

## Status

Accepted, 2026-09-26 (prototype). Evidence in `docs/findings/06-board-tools-over-mcp.md` and
`docs/findings/07-board-tools-and-layout.md`.

## Context

An agent in an agent frame should be able to see the board and change it: open the files it is
talking about, a terminal, a preview, another agent. The agent is a process on the host's machine
behind `canvas serve`; the board is a Yjs doc that lives in the browsers, with the host's browser
as its authority (ADR 0001). Guests can prompt agents, so whatever the agent can do on the board,
a guest can ask it to do.

## Decision

1. **Tools over MCP, one server per session.** `canvas serve` hands each agent session an HTTP
   MCP server (`session/new`, `session/load`) on loopback, at `/mcp/<session id>` with a secret
   of its own. Four tools: `view_board`, `open_frame`, `update_frame`, `close_frame`. The priming
   (what canvas is, clusters, etiquette) goes out as MCP server instructions: agents show them
   next to their own system prompt, never instead of it, and they never enter the thread.
2. **The host's browser runs the tools.** The server relays each call over its one WebSocket
   (`board-call` / `board-result`); the host's browser applies it to the board doc like any local
   edit, and it reaches guests the usual way. No host browser, no board tools; the agent is told.
   The server checks file paths against the shared set first (ADR 0002).
3. **An agent has the board powers of an `edit` guest, without approvals.** It opens, changes and
   closes frames. Nothing it does through the board runs anything by itself: a new agent frame
   gets only a _draft_ prompt that a person sends, and a terminal frame is an idle shell. So a
   board tool call needs no permission prompt (Claude gets them on its allowlist); tool calls
   that touch the machine still ask the host, as before.
4. **Placement is the layout's, not the agent's.** Agents name frames and sides, never pixels;
   new frames go into the agent's own cluster unless it says otherwise (`shared/layout.ts`).
   Frames an agent opens record it (`origin`).

## Consequences

- A guest with `edit` access can, through an agent, do what it could already do on the board:
  nothing more reaches the machine. Starting another agent's _process_ is new (an agent frame
  with its agent picked is brought up), but prompting it stays a person's act.
- Agents can prompt each other only through people for now; a direct `agent_prompt` would be a
  request to the host like a guest's (ADR 0001).
- The board only changes while the host's browser is open, as for everyone else. A headless host
  (ADR 0001's next step) would run the same tool code server-side.
- With several host tabs open, the first connected one runs the calls.
