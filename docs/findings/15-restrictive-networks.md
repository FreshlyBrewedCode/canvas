# 15 — Getting through restrictive networks: signalling relay and TURN (spike)

Date: 2026-09-28 · Files: `spikes/relay/*` · trystero 0.25.4, `@trystero-p2p/ws-relay` 0.25.4,
coturn 4.16.0, `turn-server` 0.6.6 (npm, pure JS), Chromium via Playwright, all on one machine.

## Question

Peers behind corporate VPNs and firewalls can't connect. What can a self-hosted relay fix, what
does it take to run one, and what does it change about security?

## Two separate failures

A trystero connection has two legs, and each one fails in its own way:

1. **Signalling.** Peers find each other and swap encrypted SDP through public Nostr relays over
   `wss://`. Networks that filter by domain or category block these relays, so peers never show
   up. The error is quiet: no `onPeerJoin` and no `onJoinError`, only relay-socket warnings.
2. **The WebRTC data channel.** Board, presence and agent traffic all go peer to peer over
   UDP/DTLS. Networks that block UDP, sit behind symmetric NAT, or force-tunnel a VPN let signalling
   through, but ICE then fails. trystero reports this in `onJoinError`: "could not connect to peer
   … after exchanging SDP; configure TURN servers".

A signalling relay fixes the first failure only. The second one needs **TURN**, a relay for the
data itself. In corporate networks that usually means `turns:` over TCP/TLS on port 443.

## Results

| mode | signalling | ICE | outcome |
|---|---|---|---|
| `direct` | our Bun relay | default (host/STUN) | connected in 136 ms, message exchanged |
| `relay-only`, no TURN (simulates blocked direct paths) | our Bun relay | `iceTransportPolicy: "relay"` | **fails**: "could not connect … after exchanging SDP" |
| `turn`, coturn, TCP | our Bun relay | relay only | connected in 177 ms |
| `turn`, `turn-server` on Bun, UDP | our Bun relay | relay only | connected |
| `turn`, `turn-server` on Bun **or Node**, TCP | our Bun relay | relay only | **fails**. Allocations and auth succeed, packets are relayed, ICE never completes |

- **A signalling relay is about 30 lines on Bun's native pub/sub** (`relay.ts`). It speaks the
  wire protocol of `@trystero-p2p/ws-relay/server`, which is
  `{type: subscribe|unsubscribe|publish, topic, payload}`, so trystero's stock `ws-relay` client
  works against it unchanged. It needs no `ws` dependency and fits into the CLI.
- **What the relay operator sees.** Hashed topics, peer ids, timing, sizes, and each peer's IP.
  SDP arrives as AES-GCM ciphertext under the room `password` (the link's `k`). That hides ICE
  candidates, including internal IPs. The operator cannot read board data, which never passes
  through signalling.
- **TURN with shared-secret credentials works** (coturn `--use-auth-secret`): the username is
  `<expiry>:<name>` and the credential is `base64(HMAC-SHA1(secret, username))`. Anything holding
  the secret can mint short-lived credentials, so the secret never has to reach a browser.
- **The pure-JS TURN server is not usable over TCP yet.** `turn-server` is four months old with a
  single maintainer. It works over UDP, but UDP is exactly what these networks block. TURN in the
  CLI would mean debugging or forking it. coturn and eturnal are the proven options.
- **Switching strategy is cheap in `room.ts`.** It uses only `joinRoom`, `makeAction`,
  `onPeerJoin`/`onPeerLeave`, `getPeers`, `leave` and `selfId`, all of which `ws-relay` exports
  with the same API. The Nostr strategy also accepts `relayConfig.urls`, but a self-hosted Nostr
  relay (e.g. strfry) is heavier than our 30 lines.
- The web app sets no CSP, so nothing stops it connecting to a custom relay host.

## Security notes

- **Signalling relay.** It cannot join a room or read SDP without `k`, and cannot pose as the host
  (ADR 0001 signature). It can drop or delay traffic (denial of service), and it learns peers'
  IPs and room activity. That is strictly less than what public Nostr relays learn today. An
  open relay invites other trystero apps to use it; the cost is small but should be limited with
  an optional access token, size limits and rate limits.
- **TURN is the real exposure.** An open or badly configured TURN server is an open proxy. It
  can also be used for SSRF into the operator's own network (CVE-2020-26262 class). Required
  settings: authentication with time-limited credentials, and denying loopback, private,
  link-local and multicast peer addresses (coturn `no-loopback-peers`, `no-multicast-peers`,
  `denied-peer-ip=…`). Add quotas too. Traffic through TURN stays DTLS end-to-end encrypted.
- **Links.** Once a link names a relay, its author picks which server guests connect to. The link
  is already fully trusted (it carries `k`), so this adds nothing new, but the UI should show
  which relay is in use.

## Follow-up: telling the two apart (connection dialog)

The reported networks have a TLS-inspecting corporate proxy and a restrictive VPN, so either leg
can be the one that fails. Before building a relay, the top bar's connection indicator now opens
a dialog (`web/lib/connection.ts`, `components/connection-dialog.tsx`). At the top, one headline
says which leg fails, with an overview under it. Details below give per-relay state, each peer's
selected candidate pair (from `getStats()`), a STUN probe, and a log. **Copy report** exports it
all as JSON without the link's secrets.

`e2e/drive.ts` `STEP=connection`, host and guest in Chromium:

- working: "Connected to one peer", route "direct, same network (UDP)", network test ok, report
  without `k`, `pk` or `token`
- WebRTC blocked (a guest whose `RTCPeerConnection` only allows relay candidates and has no TURN):
  "Found peers, but couldn't connect to them" within seconds, indicator red, two join errors
  "no network path"
- relays blocked (Playwright refuses every `wss:` socket): "No signalling relay reachable" after
  the 8 s grace, while the network test still says UDP gets out. The two legs really are
  independent

Next: have someone on the affected network send a report.
