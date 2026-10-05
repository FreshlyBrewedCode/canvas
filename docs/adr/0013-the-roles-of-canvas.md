# 0013. The roles of canvas, and frames that say where things are

## Status

Proposed, 2026-10-05 (#108, epic #78, tracker #77). Amends ADR 0001: the door to a machine is
its owner, and authority over the board is a role apart (decision 1). Builds on ADR 0011's
owners and members, and on ADR 0012's pattern: an absent field means what the board meant
before, so there is nothing to migrate.

## Context

One person's machine runs `canvas serve`, and that person's tab is the board. The tab puts the
board's updates in order, signs as host, admits members, and is the only way to the agents,
terminals and files of one working dir (ADR 0001, 0002, 0011). That is easy to start and stays
the default. But it assumes one of everything, and where we want to go has more than one
(tracker #77): a board that runs without a tab, reached from any device; a server with many
boards; agents on everyone's machine, each owner deciding what runs on theirs; sandboxes; more
than one repository or worktree on a board.

The assumption is in the code, where several roles share one place: `room.ts` orders guests'
updates, talks to `canvas serve` and shows our own presence. It is also in the data, which is
harder to change once boards depend on it. A file frame's `path` is relative to *the* working
dir. A terminal frame's PTY is the frame's id. Links, comments, file lists and
`canvas:scratch/…` paths assume the same. Every board saved that way is one more to migrate
later.

## Decision

1. **A machine's owner decides what runs on it. Authority over the board is a separate role, and
   it can live anywhere.** This generalises ADR 0001: the host's browser is the door to the
   machine because it is the browser its owner paired (ADR 0011, decision 3), not because it
   holds the board. Today's setup is the smallest case: one board, one runtime, and the authority
   in the host's tab, which is also the runtime owner's. The local, zero-config path stays
   first-class; it is not a legacy mode.

2. **canvas has six roles.** Where each lives today, and where it is heading:

   | Role | What it does | Today | Heading |
   |---|---|---|---|
   | **Board authority** | orders updates, checks each member's role, signs as host, keeps the board | the host's tab (`web/lib/room.ts`); `board.bin`, `members.json` kept by `canvas serve` (`store.ts`, `members.ts`) | into a process: `canvas serve` joins its own room (ADR 0001's next step), later a hub holds many boards. The same code in a tab, a process or a hub |
   | **Gateway** | the way from the board to a machine | the host's tab → `canvas serve`'s one socket, opened by an owner's signature (`shared/protocol.ts`, `ClientToServer`) | stops being a role: it becomes the runtime protocol, which every runtime speaks, the local one too |
   | **Runtime** | where agents, shells and files are | `canvas serve`: `agents.ts` (sessions are its, for the board, ADR 0012), `terminals.ts`, `files.ts` + `shared-set.ts`, one working dir | attaches to boards and offers agent kinds, terminals, roots (a repository or worktree, each with its shared set) and ports. It enforces its owner's policy on requests their senders signed, and trusts nothing just because the board home forwarded it. Approvals go to its owner |
   | **Board tools** | agents acting on the board | MCP in `canvas serve` (`board-mcp.ts`), run in the host's tab (`web/lib/board-tools.ts`, `drawing-kit.ts`) | run where the doc is. Those that need a DOM (Excalidraw, mermaid, `view_frame`'s images) need a renderer: any connected browser, or a headless one |
   | **Identity** | who someone is, what they may do | a key per browser, members with roles, owners paired by code (ADR 0011) | a key per person: one owner on several devices, invites tied to an identity |
   | **Transport** | how peers reach each other | a seam already: `web/lib/transport/` (ADR 0008) | unchanged in shape; a hub may take the relay's job |

   The participant (our own presence, view and focus) is not a role of the board but of each
   browser. `room.ts` holds authority, gateway and participant at once; it is split along these
   lines (#110), so that authority depends on no DOM and can later run in Bun.

3. **A runtime has an id.** `canvas serve` makes it the first time it runs in a dir: 9 random
   bytes, base64url (12 characters), saved as `{"id": "…"}` in `.canvas/runtime.json`. It is the
   runtime's, not the board's: it is not the host key, and it survives restarts and resetting
   the invite link (ADR 0011, decision 6). It is no secret. A runtime id is letters, digits, `-`
   and `_`, at most 64 (as session ids, `isSessionId`). `welcome` carries it to the host's tab
   (`runtime`), and `RoomState` to guests (`runtime`). The board's own runtime is the one that
   keeps the board: today, the `canvas serve` the host's tab is paired with.

4. **Frames carry addresses; absent means the board's own.** In the board doc, beside what the
   frame has now:
   - file frames: `runtime?: string` and `root?: string`, beside `path`;
   - agent frames: `runtime?: string`, beside `agent` (a kind that runtime offers) and `session`
     (an id of that runtime's);
   - terminal frames: `runtime?: string` and `pty?: string`, the PTY it shows, as ADR 0012 gave
     agent frames `session`.

   An absent `runtime` is the board's own runtime; an absent `root` is the runtime's working dir,
   the only root there is; an absent `pty` is the frame's own id. Writers leave all three absent
   for these: new frames, agents' tool calls, links, `tidy`. So boards from before need no
   migration, and `tidy` writes nothing. The own runtime's id written out names the same
   runtime, and compares equal to absent, but nothing writes it. A root id is letters, digits,
   `-` and `_`, at most 64, as a runtime id. Guests write the
   doc, so a value is read with care: a `runtime` or `root` that is no id names nothing reachable
   (the frame says so, nothing is sent); a `pty` that is no id is ignored, as `shownSession`
   ignores a bad `session`. Switching a terminal frame to another PTY of its runtime is a doc
   write, open to whoever may edit, as switching a conversation is: its output reaches every
   member anyway, and typing stays `trusted`'s.

5. **Everything that names a file names the same address.** With the same fields, and the same
   defaults:
   - file list entries (ADR 0005): `{display, runtime?, root?, path, lines?}`;
   - comments (ADR 0006): `{runtime?, root?, path, start, end, …}`, the file the comment is on;
   - links (ADR 0007): `LinkTarget` gains `runtime?` and `root?`, and the fragment two keys,
     written only when not the own runtime or the main root:
     `#frame=<id>&runtime=<runtime id>&root=<root id>&path=<path>&lines=10-20`.
     A relative path or a file-like code reference takes the address of where the link is
     (`LinkBase` gains `runtime` and `root`): the file it is in, else the agent frame whose
     reply it is in. An absolute path is read against that runtime's working dir, as against
     `cwd` now. "Wherever `path` shows" means a frame with the whole address.
   - agents' board tools: the paths an agent passes are of its own runtime's working dir, and
     `canvas serve` checks them against its shared set, as now. A frame the agent opens, a list
     entry it writes, a comment it makes get the runtime of the agent's frame. That is the
     runtime the call came from, so today they are written without an address, and a file frame
     an agent points at a path comes to its runtime. `view_board` marks a frame on another
     runtime as not reachable.

6. **Scratch files are a runtime's, outside its roots.** ADR 0005 keeps them with `canvas serve`,
   and an agent's scratch files stay on the machine it ran on. `canvas:scratch/<name>` keeps its
   form; its address is `{runtime?, path}`, and a scratch path with a `root` is refused. Links in
   a scratch file stay among its runtime's scratch files, as they stay among scratch files now.

7. **The wire names addresses, and `canvas serve` refuses those not its own.** Every message
   that names a session, a PTY or a file carries the same optional fields, in every direction,
   absent meaning the same:
   - host tab → `canvas serve`: `agent-prompt`, `agent-cancel`, `agent-config`,
     `agent-release`, `agent-permission`, `session-open`, `kind-probe` carry `runtime?`;
     `file-open`, `file-close` carry `runtime?` and `root?`; `tree-watch` carries `runtime?` and
     `root?`; `term-open`, `term-input`, `term-resize` carry `runtime?` and name the PTY as
     `pty` (in place of `id`);
   - `canvas serve` → host tab, and host → guests: the answers name what was asked as it was
     asked: `file` (`runtime?`, `root?`, `path`), `tree` (`runtime?`, `root?`), `term-data` and
     `term-exit` (`runtime?`, `pty`), and the session messages (`sessions`, `agent-meta`,
     `agent-event`, `agent-options`, `session-history`, `kind-options`) `runtime?`. Browsers key
     what they mirror by address, not by bare id: two runtimes may have the same session id;
   - guests → host: `GuestRequest` and `GuestRead` carry `runtime?` the same way; `term-input`
     names `pty`. The host checks the member's role as now.

   `canvas serve` takes an address as its own if `runtime` is absent or its id, and `root` is
   absent; it checks every message so, not only those above. Its answers about its own things
   leave the address absent, which names the same runtime as its id; a refusal names it exactly
   as asked. Anything else it refuses, and opens, runs or reads nothing: `file-open` answers `file`
   with `{kind: "denied", reason: "not this runtime's"}`, which the frame shows as any denied
   file; every other message answers `error`, as for a session it hasn't got. The host's tab
   sends only addresses of runtimes it is connected to — today only the own runtime — and shows
   a frame on any other as not reachable. The refusal is the backstop, as the shared set is:
   addresses come from the doc, which guests write. `board-call` needs no address: it comes from
   the runtime it is from.

8. **Not decided here.** Each is a later ADR:
   - the runtime protocol: how a runtime attaches to a board, what it offers, how the gateway
     goes away;
   - signed requests, and each runtime's owner policy and approvals;
   - several roots in practice: how roots are named and listed, worktrees as roots, a shared set
     per root, the root an agent session runs in;
   - the headless board and the hub: where the board lives, whether a board a server holds stays
     end-to-end encrypted, who renders for board tools, where scratch files go when the board's
     home is not a runtime, and what an absent `runtime` means once a board has no runtime of its
     own. That move knows which runtime absent meant, and can write it then, once.

## Consequences

- Boards from before are on their own runtime, unchanged. A link, a comment, a list entry or a
  frame in the common case looks as it does today; the address shows only where it says more.
- The protocol grows optional fields that a board with one runtime never sets, and `canvas serve`
  one check per message. That is the cost of not migrating boards later.
- A project copied with its `.canvas/` keeps its runtime id; its board is still on its own
  runtime. Deleting `runtime.json` makes a new id, which changes nothing for addresses left
  absent.
- Session and PTY ids are unique per runtime only. Browsers key sessions, terminals and open
  files by address from the start, so a second runtime adds entries, not a new keying.
- The host's tab stays the only door to the machine, as the owner's paired browser: decision 1
  changes what that door is called, not who holds it.

## Open

- Whether a runtime's id becomes the fingerprint of a key of its own, once requests are signed.
- An agent frame that moves its conversation to another runtime (sessions don't move; their
  agent's own state, e.g. `~/.claude`, stays on the machine).
