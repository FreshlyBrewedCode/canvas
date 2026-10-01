# 0001. The host's browser is the only door to the machine

## Status

Accepted, 2026-09-25 (prototype). Validated end to end in `docs/findings/03-prototype-validation.md`.
Amended by ADR 0011: a key per browser, the host admits each one with its own role, the host's
browser pairs once and then authenticates by signature, and presence goes only among members.

## Context

canvas puts coding agents that run on one person's machine onto a board several people share.
The board is peer to peer (trystero, no app server); the agents are local processes behind
`canvas serve`. Anyone who can make `canvas serve` act can run code on the host's machine, so
*who can reach the server, and through what*, is the design.

## Decision

1. **Only the host's browser talks to `canvas serve`.** It proves itself with a token the CLI
   prints inside the link's fragment (never sent to the web host). The server knows nothing
   about guests. A WebSocket is not subject to CORS, so the token is also what keeps random
   websites off `ws://127.0.0.1`.
2. **Everything with authority is a star around the host's browser.** Guests send board (Yjs)
   updates to the host only; the host applies what the guest's access allows and re-broadcasts.
   Agent threads and terminal output only exist on the host and are mirrored out. Anything that
   would run on the machine is a *request* to the host, checked against the room's access:
   `view` (refused), `edit` (the host approves each run), `trusted` (runs directly).
   Tool-call permissions the agent asks for are answered by the host only, in every mode.
3. **Presence is a full mesh.** Pointers, carets and selections carry no authority and go
   peer to peer.
4. **Guests verify the host.** Every peer holds the room key, so the key proves membership, not
   role. `canvas serve` mints an ECDSA P-256 keypair per board; the public half rides in every
   link, the private half reaches only the host's browser. The host signs
   `canvas-host:<room>:<its peer id>`; guests take board state, agent output and policy only
   from the peer whose signature verifies.

## Consequences

- A guest's read-only mode is real: their edits never reach anyone, not just "disabled in the UI".
- The host's browser must be open for the board to work — guests can see a cached board but
  nothing runs, and board edits between guests stall. Acceptable for "pair with me on my
  machine"; a headless host (the CLI joining the room itself — trystero runs on Bun) is the
  natural next step if that becomes limiting.
- The guest→host approval is per request; there is no per-person role yet (one policy per room).
- Peer ids are not cryptographically bound by trystero; the signature binds the *host* role to a
  peer id, which is enough while the room key is secret. Stronger per-guest identity would need
  guest keys too.
