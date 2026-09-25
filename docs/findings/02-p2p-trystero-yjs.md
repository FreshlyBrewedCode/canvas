# 02 — Trystero + Yjs between browsers, and reaching the local CLI (spike)

Date: 2026-09-25 · Files: `spikes/p2p/*` · trystero 0.25.4 (default strategy: Nostr), yjs 13.

## Questions

1. Does Trystero connect two independent browsers with zero infrastructure?
2. Can a Yjs document be synced over Trystero actions (no y-webrtc)?
3. Can a page on the public **https** origin talk to the CLI's plain `http`/`ws` server on
   `127.0.0.1` (mixed content / private network access)?

## Method

`serve.ts` serves the page over https with the Tailscale cert on
`dev.example.ts.net:5199`, plus a plain http+ws "local server" on `127.0.0.1:5198`.
`drive.ts` opens two separate Playwright Chromium contexts (separate storage = two users).

## Results

1. **Yes.** Peers discovered each other ~1.0 s after page load through public Nostr relays
   (some relays in the default list 502 — harmless noise, but noisy in the console).
2. **Yes.** Two actions are enough: `ysv` (send state vector on peer join) and `yupd`
   (updates + diffs). Both docs converged to the same 2 items.
3. **Yes (Chromium).** `fetch("http://127.0.0.1:…")` and `new WebSocket("ws://127.0.0.1:…")`
   both succeeded from the https origin — loopback counts as potentially trustworthy, so
   mixed-content blocking does not apply. Caveat, not tested here: headed Chrome's Local
   Network Access prompt, and Safari. **Note:** loopback only works when the browser runs
   on the same machine as the CLI; the prototype therefore also lets the CLI serve TLS on
   the tailnet name so a browser on another device can be the host.

## API note

Trystero 0.25 changed the action API: `makeAction()` returns an object
(`send(data, {target})`, `onMessage = (data, {peerId}) => …`) and room events are
properties (`room.onPeerJoin = …`), not the tuple/function-call API most examples show.
`onPeerHandshake` (async admit/deny before a peer becomes active) is available for
authenticating peers.
