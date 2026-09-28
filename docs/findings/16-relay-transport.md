# 16 — A relay transport and the transport interface (spike)

Date: 2026-09-28 · Branch `spike/relay-transport` · Draft decision: ADR 0008. Code:
`src/server/relay.ts`, `src/shared/relay-{token,protocol}.ts`, `src/web/lib/transport/*`, plus the
`room.ts` refactor. Tests: `relay-token.test.ts`, `transport/relay.test.ts`. e2e:
`e2e/drive.ts STEP=relay`.

## Question

Can one `canvas relay` do both signalling and transport, for many boards, admitting only tokens
from its issuers? And how invasive is putting `room.ts` behind a transport interface?

## Results

**The refactor is small.** `room.ts` changed by +54/−39 lines. trystero's action API was
already the right shape, so the interface copies it:

- `channel(name)`: `send(data, {target})` and `onMessage`
- `requests(name)`: `request(data, {target})` and `onRequest`
- `peers()`, `onPeerJoin`/`onPeerLeave`, `leave()`, `diagnostics()`

The trystero adapter (Nostr, or relay signalling) is about 60 lines. The relay adapter is about
240 lines, plus 130 for the sealed envelope. The relay server is about 170 lines on `Bun.serve`,
with no new server dependencies. The client uses `partysocket` for reconnecting and WebCrypto for
everything cryptographic.

**e2e**, a host and guests in Chromium against a local relay, `dev` and `canvas serve --relay …`:

| `--relay-via` | locked-down guest | checks |
|---|---|---|
| `transport` | every `wss:` refused (no Nostr), and `RTCPeerConnection` throws | 7/7 |
| `signal` | every `wss:` refused (no Nostr), WebRTC allowed | 7/7 |
| none (Nostr, `STEP=connection`) | — | 13/13, unchanged |

The checks:

- the host sees the guest, and the route in the dialog is "through canvas relay" or a WebRTC route
- the guest link carries a guest token, never the host's
- the locked-down guest verifies the host ("host online")
- board edits reach it from the host, and from it to the host
- in a `trusted` board, its terminal input is a request that runs on the host (`echo
  relay-$((6*7))`), and `relay-42` comes back to both
- a guest link with a forged token is refused: "Can't reach the relay" (transport), or "No
  signalling relay reachable" (signal, HTTP 401)

**Unit and integration tests** (`bun test`, against a real relay on a random port):

- peers meet, send JSON and bytes, and request/reply including errors
- two boards on one relay don't hear each other
- tokens for another room, from an unknown issuer, or expired are refused
- a newer host tab takes over the room
- 500 unawaited sends arrive whole and in order
- a request waiting for approval doesn't block other messages
- the envelope drops tampered, replayed, mis-attributed, stale and other-board messages
- tokens: a changed role or room breaks the signature, and removing an issuer revokes

**Loopback cost** (Bun ↔ Bun through the relay, so only encryption and forwarding):

| | |
|---|---|
| join, both peers | 4–6 ms |
| request round trip | 0.25–0.4 ms |
| 8 MB message (sealed, forwarded, opened) | 80–100 ms |
| 2,000 small messages, unawaited | 173 ms |

## Bugs found on the way

- **Out-of-order sealing broke the replay counters.** `room.ts` sends without waiting (`void
  send`), and AES-GCM in WebCrypto is async, so a burst could leave out of counter order. The
  receiver then dropped the late ones as replays: about 1,900 of 2,000 in the benchmark. Order
  matters beyond counters too (terminal output, agent events). The fix is one queue for
  sealing+sending and one for opening. Dispatch runs outside the queue, so a request waiting for
  the host doesn't hold up the others.
- **The connection dialog could sit under the board.** Frames and pointers carry z-indexes up to
  100000, and the board had no stacking context of its own. The board is now `isolate`, which
  also belongs on PR #18. (The faded dialog in the first screenshot was its fade-in caught
  mid-way.)

## Not done in the spike

- No Docker image or docs guide.
- No rate limits, and no TLS other than `--cert`/`--key` on the relay.
- No refreshing of guest tokens while `canvas serve` runs. They're signed at start and last 30
  days.
- No per-pair fallback from WebRTC to the relay.
- Not tried on the reported network.

## Hardened for the PR

- **Tokens are signed each time a host tab connects**, in `welcome`, with `node:crypto`: only
  `canvas serve` and the relay handle tokens, and the browser never does. The host link no longer
  names the relay; guest links carry a fresh guest token.
- **Limits** (`relay-config.ts`, all environment variables): per-connection message and byte
  rates (token buckets with 4 s bursts; a message larger than the burst passes on a full bucket),
  peers per room, connections per issuer, the largest message. A connection must join within
  10 s. `/signal` takes messages up to 64 KB only.
- **Docker**: `Dockerfile` bundles `server/relay-main.ts` into one file on `oven/bun:1-slim`:
  170 MB, most of it the base image. It has a health check on `/health`. CI builds it and checks
  `/health`, and the release smoke test runs `canvas relay` from the installed package.
- Running the image caught a bug the unit tests had missed: without environment overrides, the
  64 MB message limit came out as 64 bytes, because the default wasn't scaled. There's now a test
  for the defaults.

e2e, the relay in Docker (the published artifact), a local `dev`:

| run | configured by | result |
|---|---|---|
| `STEP=relay`, transport | `CANVAS_RELAY`, `CANVAS_RELAY_KEY` | 8/8 |
| `STEP=relay`, signal | the same plus `CANVAS_RELAY_VIA=signal` | 8/8 |
| `STEP=takeover`, transport | `--relay`, `--relay-key` | 7/7 |
| `STEP=basic`, transport (opencode: shared draft, guest prompt, host approval, streamed thread, permissions) | env | completed; the guest sees the whole thread |
| `STEP=connection`, no relay | — | 13/13 |
| `STEP=takeover`, no relay | — | 7/7 |

The last check of `takeover` over Nostr ("the guest sees the host again") failed three times
before this change, on `main` too, and passes now. The runs don't say whether the change fixed
it or it was flaky.
