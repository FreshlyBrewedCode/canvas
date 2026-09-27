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

1. **Only the host's browser talks to `canvas serve`.** It proves itself with the token in the host
   link. Without `--tls-host`, `canvas serve` only listens on `127.0.0.1`. The token is also what
   keeps other websites off that local port: WebSockets are not protected by CORS.
2. **Guests reach the machine only through the host's browser**, which checks every request
   against the [guest access](/docs/guests): view (refused), edit (the host approves), trusted
   (runs).
3. **Agent permissions are answered by the host only**, whatever the guest access.
4. **Guests verify the host.** `canvas serve` makes a key pair per board. The public key is in
   every link; the private key reaches only the host's browser, which signs its peer id with it.
   Guests take the board, agent output and the guest access only from the peer whose signature
   verifies.

## The links

| Link        | Holds                                          | Gives                              |
| ----------- | ---------------------------------------------- | ---------------------------------- |
| Host link   | Room id, room key, host public key, server URL, token | Control of `canvas serve`: agents, shells, files |
| Guest link  | Room id, room key, host public key             | A seat on the board, with the guest access |

Secrets travel in the URL fragment, which the browser never sends to the server hosting the web
app. The room key also encrypts the signalling that goes through the public Nostr relays. Anyone
holding the guest link can join; there are no per-person accounts or roles.

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

Guest access narrows what reaches the machine; it does not make guests harmless.

- **Trusted guests** send prompts and type into terminals without approval. A terminal runs as the
  host's user: a trusted guest can do anything the host can.
- **Edit guests** can add agent and terminal frames, which start an idle agent process or shell on
  the host's machine, without approval. Prompting an agent needs the host's approval; typing into
  a terminal is not open to edit guests at all.
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
- **Peers see each other's IP addresses**, as with any WebRTC connection.

## Not covered

No audit, no rate limits, no per-guest identity (peer ids are not cryptographically bound; the
host signature binds only the host role), no way to revoke a guest link other than deleting
`.canvas/` for new links. See [Limits](/docs/limits).
