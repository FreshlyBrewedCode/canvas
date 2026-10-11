---
title: Connection
description: The connection dialog, and what it says when people can't connect.
section: Technical
order: 4
---

The dot in the top bar says what your browser reaches: **connected to canvas serve** for the host,
**host online** for a guest. It turns red when something is wrong, and counts new errors. Click it
for the connection dialog. A guest waiting in the [lobby](/docs/guests#the-lobby) sees what is wrong
there too, with **Connection details** to open it.

## Two legs

Joining a board takes two steps, and a restrictive network (a corporate proxy, a VPN, a firewall)
can block either one:

1. **Finding each other.** Browsers meet through public Nostr relays, the **signalling relays**,
   over `wss://`. They exchange connection offers there, encrypted with the room key. If none of
   them is reachable, nobody shows up.
2. **Connecting.** Browsers then connect directly over WebRTC, usually UDP. If no network path
   works, people find each other and then fail to connect.

## The dialog

At the top, one line says what's wrong, or that all is well:

| It says                                        | What it means                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Can't reach canvas serve**                   | Host only: `canvas serve` has stopped, or is on another port than the host link names.             |
| **No signalling relay reachable**              | This network blocks the Nostr relays.                                                             |
| **Found peers, but couldn't connect to them**  | The relays work, but WebRTC doesn't: usual behind VPNs and firewalls that block UDP.              |
| **Waiting for the host**                       | The relays work and nobody else is there yet. The host's browser may be closed.                   |
| **Connected to … peers**                       | All is well. The dialog says, per person, whether the connection is direct or relayed.             |
| **Can't reach the relay**                      | The board is on a [canvas relay](/docs/relay), and it doesn't answer or refused the link's token (it lasts 30 days). |

Below that, an overview: `canvas serve` (host), whether the host is verified (guest), how many
signalling relays are open, and a **network test**. The test asks public STUN servers for this
machine's address as the internet sees it. If none answers, UDP doesn't get out, and people on
other networks can't connect to you directly. Then the people you're connected to, and recent
errors.

**Details** has each relay's state, each connection's route (candidate types, addresses, round
trip, bytes), what the network test found, versions and browser, and a log of everything that
happened to the connection since the page loaded.

**Copy report** copies all of it as JSON, to send to whoever helps you debug. It has no keys or
tokens, but it has IP addresses.

## When it keeps failing

A board on a [canvas relay](/docs/relay) avoids both failures: every browser keeps one `wss://`
connection to the relay, as it would to any web app.
