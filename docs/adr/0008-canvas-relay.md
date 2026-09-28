# 0008. A canvas relay, for networks where peers can't connect

## Status

Accepted, 2026-09-28 (prototype). Evidence in `docs/findings/15-restrictive-networks.md` and
`docs/findings/16-relay-transport.md`. Amends ADR 0001 (how peers reach each other; not who
holds authority).

## Context

Peers on corporate networks can't join boards. One reported network has a TLS-inspecting proxy
and a VPN. Its connection dialog report: the Nostr relays answer, UDP reaches a STUN server, and
WebRTC still fails after the peers exchange offers. The usual cause is a NAT that maps each
destination to a different port. Only a relay in the middle helps.

WebRTC's own answer is TURN. It's little code in canvas, but it asks the host to run coturn
(UDP port ranges, shared secrets, rules against relaying into private networks) or to sign up for
a hosted one. TURN over TLS is also what inspecting proxies tend to break. "Run this small
WebSocket server" is easier to ask for, and `wss://` on 443 passes wherever the web does.

## Decision

1. **Peers reach each other through a `Transport`** (`web/lib/transport/`): named channels to one
   peer or everyone, request/reply to one peer, peers joining and leaving. `room.ts` sees only
   that. There are three adapters, and the board's link picks one:
   - `p2p`: trystero, meeting on Nostr and talking over WebRTC (as before);
   - `relay-signal`: trystero, meeting on a `canvas relay` and talking over WebRTC;
   - `relay`: everything through a `canvas relay`.
2. **`canvas relay` ships with the CLI**, and as a Docker image (`Dockerfile`: the relay alone,
   bundled into one file). It is one Bun process with two paths, `/signal` (trystero's ws-relay
   protocol) and `/transport`, plus `/health`. It stores nothing and reads nothing. Per-connection
   message and byte rates, and caps on peers per room and connections per issuer, keep one board
   or issuer from starving the rest.
   - One relay serves any number of boards and hosts.
   - A relay room is derived from the board key (`HKDF(k)`), not the `?room=` id, so the relay
     can't match rooms to board URLs.
   - The relay binds each peer id to its socket, so a peer can't send as another.
   - A room has one host at a time: a newer host tab takes over, as with `canvas serve`.
3. **Access is by issuer keys and signed tokens.** The operator configures named issuer keys
   (`CANVAS_RELAY_KEYS=name:secret,…`) and gives one to each host or team.
   - `canvas serve --relay URL --relay-key name:secret` signs two tokens,
     `v1.issuer.room.role.expiry.hmac`, each time a host tab connects: one for that tab and one
     for its guest links. Each is good for its room only, for 30 days. The host link doesn't
     change; the host tab gets its token and the relay from `canvas serve`.
   - The relay verifies them without storing anything. Removing an issuer revokes everything it
     signed.
   - The token goes in the first message over `/transport`. On `/signal` it goes in the query
     string, because trystero's client can't send it any other way.
4. **Over the relay transport, peers encrypt everything end to end.**
   - AES-GCM with one fixed key per board, derived from `k`. The relay room is the additional
     data, so a message only opens in its own room.
   - Inside the seal are the sender's id (checked against the id the relay stamps), a random
     epoch per page load, a counter and the time.
   - Receivers take each sender's counter only upwards, and drop anything older than two
     minutes. A relay can't replay a request to the host to run it again.
   - Sealing and opening run in order, each through a queue.
5. **Authority doesn't move** (ADR 0001). The host's browser still decides and signs, and guests
   still verify the host by its signature. The relay is a pipe.
6. **Configuration is environment variables, with flags where useful; no config file.**
   `serve`: `CANVAS_RELAY`/`--relay`, `CANVAS_RELAY_KEY`/`--relay-key`,
   `CANVAS_RELAY_VIA`/`--relay-via` (default `transport`: with a relay, it carries everything).
   `relay`: `CANVAS_RELAY_KEYS` (environment only), `CANVAS_RELAY_PORT`, `_HOST`, `_TLS_CERT`,
   `_TLS_KEY` (with flags), and `CANVAS_RELAY_MAX_PEERS`, `_MAX_CONNECTIONS`, `_MAX_MESSAGE_MB`,
   `_RATE`, `_BANDWIDTH_MB`. Guest links carry the relay and a guest token in their fragment
   (`relay`, `via`, `rt`).

## Consequences

- A guest behind a proxy that only lets HTTPS out can join, as long as the relay is reachable.
  So can a network that blocks WebRTC entirely.
- **No forward secrecy.** Anyone who records a relay's traffic and later holds a guest link can
  read it. MLS (`ts-mls`) would be the upgrade.
- The relay operator sees who is in which room, their IP addresses, and the timing and size of
  every message, but no content. The operator carries all of a relayed board's traffic.
- Guest links stop working 30 days after they were copied. "Copy guest link" always gives a fresh
  one.
- On `/signal`, the token sits in a URL, where proxies may log it. The token only admits one room,
  and the board key still guards that room.
- There are two transports to keep working. Most of the shared shape comes from trystero's API,
  and the relay adapter is about 240 lines.
- Everyone on a relayed board depends on the relay. They already depend on the host's browser.

## Open

- A config file. When there's more to set than one relay, a user-level file fits better than one in
  `.canvas/`: the relay and issuer key belong to a person or company, not a project.
- Falling back to the relay per pair of peers, instead of per board.
- Publishing the Docker image to a registry. For now it's built from the repository.
- A public default relay run by frebreco.
