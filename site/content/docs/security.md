---
title: Security
description: The trust model, what guests can reach, and what they can still do.
section: Technical
order: 2
---

> **canvas is a prototype, not a hardened tool.** Its security model is designed, written down and
> tested by hand, not audited. Only invite people you would let use your keyboard, only on
> projects without secrets you cannot rotate, and never where security is an absolute requirement.

## The model

canvas runs agents and shells on the host's machine and lets other people reach them. So the
design is about **who can make `canvas serve` act, and through what**:

1. **Only the host's browser talks to `canvas serve`.** The host pairs a browser once, with the
   pairing code in the first host link: good for 10 minutes and one browser. From then on that
   browser proves itself on every connection by signing a one-time challenge from `canvas serve`
   with its key; a connection that hasn't gets nothing else. Without `--tls-host`, `canvas serve`
   only listens on `127.0.0.1`. The challenge is also what keeps other websites off that local
   port: WebSockets are not protected by CORS.
2. **Guests reach the machine only through the host's browser**, which checks every request
   against the requesting member's [role](/docs/guests#members-and-roles): view (refused), edit
   (the host approves), [trusted](/docs/guests#trusted-for-this-session) (runs; never saved, gone
   when the host's tab reloads). Someone the host hasn't let in gets refused.
3. **Agent permissions are answered by the host only**, whatever the guest's role.
4. **Guests verify the host.** `canvas serve` makes a key pair per board. The public key is in
   every link; the private key reaches only the host's browser, which signs its peer id with it.
   Guests take the board, agent output and their role only from the peer whose signature
   verifies.
5. **The host verifies everyone else.** Each browser has its own key, kept where the page can use
   it but not read it out. On joining, a guest signs its peer id with it, over a one-time challenge
   from the host; the host checks it and tells everyone each peer's verified
   [fingerprint](/docs/board#presence). A fingerprint says which browser someone is on, not who
   they are: names are what people typed.
6. **The host lets each browser in.** The guest link is an invite. A browser whose key isn't a
   member's waits in the [lobby](/docs/guests#the-lobby): the host sends it nothing of the board,
   agents, terminals or files, and drops what it sends, until the host admits it with a role.
   Members are found by their whole key, not the short fingerprint people see. `canvas serve`
   keeps them in `.canvas/members.json`; removing one cuts them off at once.

## The links

| Link        | Holds                                          | Gives                              |
| ----------- | ---------------------------------------------- | ---------------------------------- |
| Host link   | Room id, room key, host public key, server URL; a pairing code until a browser pairs | In a paired browser, control of `canvas serve`: agents, shells, files. Elsewhere, a seat as a guest at most |
| Guest link  | Room id, room key, host public key; with a relay, its URL and a relay token | A knock: a seat in the lobby, and on the board once the host lets that browser in |

Secrets travel in the URL fragment, which the browser never sends to the server hosting the web
app. A leaked host link is useless once the host has paired; a leaked pairing code is good for
minutes, and once. `canvas pair` pairs another browser; `.canvas/owners.json` lists the paired
ones. The room key also encrypts the signalling that goes through the public Nostr relays. Anyone
holding the guest link can knock; only browsers the host lets in get the board.

## With a canvas relay

A board on a [canvas relay](/docs/relay) sends everything through a server someone runs. The
browsers encrypt every message with a key derived from the room key, so the relay:

- can't read or change the board, agent threads, terminals or files;
- can't pose as the host (guests still check its signature) or as anyone else;
- can't replay a request, such as a prompt, to run it twice;
- does see who is on which board (their IP addresses), when, and how much they send, and can drop
  or delay traffic.

There is no forward secrecy: someone who records the relay's traffic and later holds a guest link
can read what they recorded. Relay tokens admit one board for 30 days. The relay's operator can
revoke an issuer key, which ends every token it signed.

The web app's code runs with your host link's secrets in it. Using the hosted web app means
trusting whoever serves it; you can point `--web-url` at a copy you serve yourself.

## The shared set

Files reach guests read-only, from a set `canvas serve` fixes. It serves a path only if all of
these hold, checked on every read:

- it resolves, symlinks included, inside the project directory;
- no part of it is `.git` or `.canvas`;
- its name is not a well-known secret: `.env` and `.env.*` (but not `*.example`, `*.sample`,
  `*.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ecdsa`, `id_ed25519`,
  `id_dsa`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.htpasswd`;
- in a git repository, git does not ignore it. Outside git, no part of it is `node_modules` or
  starts with a dot.

There is no file write in canvas at all. File content never enters the board document, so a guest
cannot change what others see. The rules apply to the host too: `canvas serve` cannot tell them
apart.

## What guests can still do

Roles narrow what reaches the machine; they do not make guests harmless.

- **Edit guests** can add agent and terminal frames, which start an idle agent process or shell on
  the host's machine, without approval. Prompting an agent needs the host's approval; typing into
  a terminal is not open to edit guests at all.
- **Trusted members** run everything without approval and type into terminals, as the host's user:
  they can do anything the host can, until the host takes it back or its tab reloads.
- **An approved prompt** can ask the agent for anything. The agent's own permission prompts, which
  only the host answers, are the next line of defence; an agent in an auto-approve mode has none.
- **An agent can read what files frames cannot**, `.env` included, and write it into its thread for
  everyone.
- **A secret in a tracked file with an ordinary name** is in the shared set.
- **A browser frame** loads whatever http(s) URL an edit guest enters, in everyone's browser,
  including the host's. A `localhost` URL loads only in the host's browser, so an edit guest can
  make the host's browser open a page on a service on the host's machine.
- **Scratch files** are whatever an agent writes, and anyone who can prompt an agent can have it
  write one. Only agents can write them; the board holds just their paths.
- **An HTML file in a files frame** runs its scripts in everyone's browser. They are sandboxed away
  from canvas and the board, but can still reach the network. Its links reach the board only on a
  person's click in it: then it can do what a link in markdown can, open a file of the shared set
  in a frame.
- **Comments are the web app's rule, not the host's.** The app lets people change only their own
  comments, and the host anyone's. Edit guests' board changes still reach everyone unchecked, so a
  modified client can change or delete any comment, as it can any frame. A comment keeps the lines
  it is about, so those lines are in the board document for everyone on it.
- **A drawing** is whatever edit guests and agents put in it, like any board data. Embedded web
  pages in it don't load, and its links go through the board's own link handling.
- **Peers see each other's IP addresses**, as with any WebRTC connection. Through a relay's
  transport they don't; the relay does.
- **Someone in the lobby holds the room key.** The host sends them nothing, but cursors and other
  presence go between guests directly, so they may still see other guests' and show their own. A
  removed member keeps the key too, and with it can decrypt a relay's traffic for the board.

## Not covered

No audit, no rate limits (except on a canvas relay), no way to change the room key of a guest link
other than deleting `.canvas/` for new links. See [Limits](/docs/limits).
