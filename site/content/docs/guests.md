---
title: Guests
description: Guest links, the lobby, members and their roles, and approvals.
section: Features
order: 2
---

## Guest link

The host copies it with **Copy guest link** in the top bar. It holds the room's key and the host's
public key, but not where `canvas serve` is or a pairing code: only a browser paired as host
controls it. A guest link is an invite: it finds the board, and the host decides who comes in
and what they can do there.

Both links keep their secrets in the URL fragment (after `#`), which browsers never send to the
server hosting the web app.

## The lobby

Someone who opens the guest link in a browser the host hasn't let in yet waits in the **lobby**:
**Waiting for the host to let you in**, with their browser's whole
[fingerprint](/docs/board#presence). They see nothing of the board until then, and nothing they
do reaches it.

The host sees a card for each knock: the name they typed and their whole fingerprint. Names are
what people typed; if it matters, ask them to read you the fingerprint their lobby shows. Then:

- **Admit to edit** or **Admit to view**: they are a **member** with that role, and the board
  appears for them.
- **Deny**: they are told the host didn't let them in. Opening the link again knocks again.

Members come back without knocking: the same browser, after a reload or another day, goes straight
in. Another browser or device is another fingerprint, and knocks. While the host's tab is closed,
nobody new gets in.

## Members and roles

**Members** in the top bar lists everyone the host let in, by name and fingerprint, with a dot for
who is here now. Each member has a role, which the host changes there at any time; a guest sees
theirs as a badge.

| Role               | Board                              | Runs on the host's machine      |
| ------------------ | ---------------------------------- | ------------------------------- |
| **view**           | Read-only; sees the files others open, no file tree | Nothing                  |
| **edit**           | Edits frames and prompt drafts, opens files, browses the tree | Only after the host approves |

A view member's edits never leave their browser: the host drops them.

**Remove** cuts a member off at once: they are told so, and the board goes away for them. If they
open the link again, they knock again. They still hold the guest link, so they can knock; see
[Limits](/docs/limits#guests).

`canvas serve` keeps the members in `.canvas/members.json`.

## Approvals

For members with the edit role, these become an approval card for the host:

- sending a prompt
- changing an agent's settings
- stopping an agent

The host presses **Run on my machine** or **Decline**. The guest's frame says **waiting for the
host to approve…** until then.

![An approval card: a guest wants to send a prompt](./screenshots/approval.webp)

## Permissions are the host's

When an agent asks for permission to run a tool call, for example a shell command, only the host
can answer, whatever the guest's role. Guests see the request, marked as waiting for the host.
See [Agent](/docs/agent#permissions).

## Terminals

Only the host types into a terminal frame. Everyone sees its output.

## When the host is away

Everything goes through the host's browser. If it is closed, guests see the board as they last had
it and **waiting for host…**; nothing runs, and edits between guests wait for the host.
