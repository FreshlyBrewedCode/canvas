# 0011. A key per browser; the host admits each one, and pairs once

## Status

Proposed, 2026-10-01 (epic #86). Amends ADR 0001: who reaches `canvas serve` (decision 1), what a
guest's access is per (decision 2), who gets presence (decision 3). ADR 0001 left it open:
"Stronger per-guest identity would need guest keys too." This is that step.

## Context

The risk that matters is what someone holding a link can do, and links leak: they get pasted into
chats, synced with browser history, caught in screenshots. Today:

- **Guest links never expire.** The room key `k` that lets someone in is fixed in
  `.canvas/room.json`. Only the relay token (`rt`) runs out, after 30 days (ADR 0008). Nothing
  revokes a guest link short of deleting `.canvas/`.
- **The host link is a lasting bearer token.** It sits in the URL's fragment, and whoever holds it
  has a shell on the host's machine.
- **The room key gets you more than the host allows.** Presence is a full mesh. On the relay
  transport every message is sealed with one fixed key derived from `k`, without forward secrecy.
- **Access is per room, not per person** (`GuestAccess` in `web/lib/room.ts`). Peer ids are bound
  to no one but the host.

The relay is not where the risk is; the link's lifecycle is.

## Decision

1. **Identity is a key per browser.** A non-extractable ECDSA P-256 key, kept in IndexedDB, made
   the first time a browser opens canvas. People see it by its fingerprint, a short hash of the
   public key, readable (`ab12 cd34`) and a stable id. Each peer proves it on join: it signs
   `canvas-peer:<room>:<its peer id>:<nonce>` with a nonce from the host, and the host verifies.
   That binds the peer id to the key, as ADR 0001's signature binds the host's. Guests learn each
   other's verified fingerprints from the host. No names are proven: a name is what someone typed.
   Accounts may replace the key later.
2. **The guest link is an invite.** The room key finds the room and admits nobody. A browser the
   host doesn't know waits in a lobby: the host sends it no board, presence or agent output, and
   refuses its requests and updates. The host sees each knock with its name and fingerprint, and
   admits it as `view` or `edit`, or denies it. A role is per member, and requests are checked
   against the requesting member's role. Members are saved by `canvas serve`, in
   `.canvas/members.json` (fingerprint, public key, name when admitted, role), not in the doc,
   which every member holds.
3. **The host pairs once.** `canvas serve` prints a pairing code in place of the lasting token:
   random, good for 10 minutes and for one use. The first browser to present it is saved as the
   owner (`.canvas/owners.json`). From then on the server authenticates the host's browser by
   challenge and signature with its key: it sends a nonce, the browser signs it, and a socket
   that hasn't answered gets nothing else. As the token did, this keeps other websites off
   `ws://127.0.0.1`. More devices pair with `canvas pair` (or `canvas serve --pair`), which prints
   a fresh code. A host link opened elsewhere after pairing is refused.
4. **Trusted lasts one host session.** The host grants it to a member on top of their saved role:
   requests run without the approval click, and typing into terminals is allowed. It is never
   saved; when the host tab reloads or closes, the member is back to their saved role.
   `members.json` holds only `view` and `edit`.
5. **The host signs the member list.** The connected members' fingerprints and peer ids, with a
   version, signed with the host key and broadcast on each change. Guests send presence only to
   peers on the latest list and accept it only from them. Someone in the lobby gets nobody's
   presence, and theirs reaches nobody. On the relay transport the host sends only to members.
6. **The room key rotates.** On "Reset invite link", and automatically when a member is removed,
   `canvas serve` mints a new room key (and with it the relay room and tokens) and saves it in
   `room.json`. The host hands it to admitted members over the current channels, and everyone
   moves to the new room. Anyone else, removed members included, is left in the old one. Old
   links lead to an empty room.
7. **No migration.** Boards from before start over with a new `room.json`; there is no
   compatibility code for the old token or room-wide access.

## Consequences

- A leaked guest link gets a stranger into the lobby, where the host sees them knock. A leaked host
  link is useless once the host has paired; a leaked pairing code is good for minutes, and once.
- Identity is per browser, not per person: the same person on a second browser or device knocks
  again, under another fingerprint. The host tells people apart by fingerprint only.
- Guests wait in the lobby while the host's tab is closed. Nobody new gets in without the host,
  as nothing runs without the host (ADR 0001).
- A removed member keeps the old room key until rotation, and rotation is automatic on removal.
  What they recorded before stays readable to them: on the relay transport there is still one key
  per board and no forward secrecy (ADR 0008).
- The doc is still one Yjs doc that every member holds whole. Roles decide what reaches the host
  and is applied, not what a member can read.
- Peer ids are now bound for everyone, not only the host. Authority doesn't move: the host's
  browser still decides and signs. `canvas serve` now keeps the member list, but guests still
  never talk to it.

## Open

- One-time or pre-approved invites, and named invites.
- Encrypting each message to each member (MLS), instead of one key per board.
- Accounts, replacing or vouching for browser keys.
