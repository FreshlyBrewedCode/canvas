# 0002. Files reach guests read-only, from a set the server fixes

## Status

Accepted, 2026-09-26 (prototype). Evidence in `docs/findings/05-files-frame.md`.

## Context

The markdown frame (ADR 0001 era) kept a file's path in the board and its content in a
`md:<frameId>` Y.Text. The host's browser watched whatever path a frame named and wrote the
Y.Text back to disk. The board is editable by any guest with `edit` access, and the server only
checked that the path *text* stayed under the working dir. So a guest, without any approval,
could read `.canvas/room.json` (the host token and the host's private key), `.env`, anything a
symlink in the repo points to, and write any file in the project (spike 04). That is a door to
the machine that bypasses ADR 0001's "anything that touches the machine is a checked request".

The markdown frame becomes a files frame: any text file, a file tree, markdown rendered by
default. Showing files to guests is the point, so the question is which files, and who decides.

## Decision

1. **The server fixes the shared set; nothing in the browser can widen it.** `canvas serve`
   serves a path only if all of these hold, checked on every read:
   - it resolves (symlinks included) inside the working dir;
   - no segment is `.git` or `.canvas`, and the name is not a well-known secret (`.env`,
     `.env.*` but not `*.example`/`*.sample`/`*.template`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
     `id_rsa`/`id_ecdsa`/`id_ed25519`/`id_dsa`, `.npmrc`, `.netrc`, `.pypirc`,
     `.git-credentials`, `.htpasswd`);
   - in a git repo, git does not ignore it (`git check-ignore`; tracked files count as not
     ignored). Outside git, no segment is `node_modules` or starts with a dot.

   The tree lists the same set (`git ls-files --cached --others --exclude-standard`, or a walk).
   A path that does not exist yet may be opened if it would be shared, so a frame can wait for
   an agent to write it. Files over 1 MiB, and binary files, are reported as such, not sent.
   The server cannot tell the host from a guest, so this applies to the host too.
2. **Read-only.** There is no file write in the protocol. Agents change files; the frame shows
   them live.
3. **File content is host-mirrored, not board state.** A frame's `path` in the board is a
   request; the host's browser opens it with the server and mirrors the content to guests the
   way it mirrors terminals. Content never enters the Yjs doc, so a guest cannot forge what
   others see, and nothing is persisted in `board.bin`.
4. **Access follows the room's policy (ADR 0001), without approvals.** A `view` guest cannot
   change the board, so it sees the files others open but cannot open its own; the host does
   not send it the tree. `edit` and `trusted` guests open files and browse the tree directly:
   reading inside the shared set needs no per-file approval — the set is the host's consent.
5. **Selections are presence.** Line ranges in the source view and text ranges in the markdown
   preview travel over the mesh like thread selections. They carry no authority.

## Consequences

- The `.canvas/room.json` and write holes are closed; a guest can reach nothing outside the
  shared set through a frame.
- Collaborative markdown editing is gone. The board cannot create files either — a frame can
  point at a path an agent has not written yet.
- The set is fixed by rule, not configurable. If a project keeps a secret in a tracked,
  unusually named file, it is shared; a `.canvasignore` is the natural next step if needed.
- This covers the frame only. An agent can still `cat .env` into its thread (the host answers
  its tool permissions), and a `trusted` guest has a terminal.
- The whole tree listing goes to every guest with `edit` or `trusted` at once — about 130 KiB
  gzipped for a 21k-file repo, fine at prototype scale.
