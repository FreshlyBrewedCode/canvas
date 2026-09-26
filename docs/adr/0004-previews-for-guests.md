# 0004. Previews: localhost stays with the host, HTML files render sandboxed

## Status

Accepted, 2026-09-26 (prototype). Evidence in `docs/findings/09-previews.md`.

## Context

A browser frame is most useful for a dev server on the host's machine or for a plain HTML file
an agent wrote. Both only worked for the host. The frame shared its URL and every viewer's
browser loaded it, so for guests `localhost:5173` meant their own machine: the page stayed blank,
or showed whatever the guest runs on that port. That was also a small hole in its own right. The
URL comes from the board, so any edit guest can make every peer's browser load any URL,
including one on that peer's loopback. And a repo HTML file could only be read as source.

Showing the host's dev server to guests would need something new on the host's machine: a way
for guests to reach its loopback. This decision covers the cheap part without it and leaves that
for later (see Future work).

## Decision

1. **A loopback URL is the host's.** A browser frame whose URL points at loopback (`localhost`,
   `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]`, `[::]`, IPv4-mapped loopback) loads only in
   the host's browser. Guests get a notice instead of an iframe. The hostname is read the way the
   browser reads it (`new URL`), so shorthands like `127.1` count.
2. **Only http(s) loads.** Any other URL in the board (`javascript:`, `data:`, `file:`, `blob:`)
   shows a notice for everyone. The address bar and the board tools only write http(s), but the
   board is a Yjs doc any edit guest can write directly. A typed address without a scheme gets
   `http://` on loopback and `https://` otherwise.
3. **HTML files of the shared set render.** A files frame shows `.html`/`.htm` rendered by
   default, like markdown, and the preview/source toggle is shared. The file's text is the one
   the host already mirrors (ADR 0002). It goes into an `<iframe srcdoc>` with
   `sandbox="allow-scripts"` and no `allow-same-origin`. The page's scripts run in an opaque
   origin: they cannot read the web app's storage (the room key, the host link's token and
   private key), reach the parent document, navigate the board or open windows. Relative URLs
   don't resolve: one-file pages only. Agents are told to inline what they need.

Nothing new reaches `canvas serve`. The protocol and the server are unchanged.

## Consequences

- Guests no longer load their own loopback because of a URL someone else put on the board.
- The host still does: an edit guest can point a frame at, say, `http://localhost:8080/admin`,
  and the host's browser loads it. That's a GET from the host's browser, with its cookies, to a
  service on the host's machine. It was already possible and stays documented. Gating
  guest-written loopback URLs behind a click from the host is the natural next step if it
  matters.
- Repo HTML now runs its scripts in every viewer's browser. The sandbox keeps it off the web
  app's origin, but it can still make network requests of its own and show anything, including
  content made to look like part of canvas. It only has its own text, which everyone can already
  read in the source view.
- An HTML preview keeps its own scroll, and selections don't reach it, as with browser frames.
- Previewing a dev server to guests still needs a URL their browser can reach, which today means
  a tunnel the host sets up.

## Future work

In order of effort:

- **Tunnel integration**: `canvas serve --expose <port>` starts `cloudflared` or
  `tailscale funnel` and puts the public URL in the frame. Complete (HMR, cookies,
  WebSockets), but the dev server is then reachable by anyone holding the URL, not just the
  room. That breaks ADR 0001's "the host's browser is the only door". Better documented as
  something the host does on purpose than built in.
- **Multi-file static previews**: serve a directory of the shared set through a service worker,
  so relative CSS, JS and images resolve. Needs binary files over the mirror, and a separate
  origin for the preview: a service worker doesn't control sandboxed opaque-origin frames, and
  the page must not share the web app's origin.
- **Host-relayed preview proxy**: a guest's iframe on a separate preview origin whose service
  worker turns each request into a request to the host's browser, which asks `canvas serve` to
  fetch it from the host's loopback. It follows ADR 0002's principle: **the server fixes the set
  of exposed ports** (`--expose`, or a host-only action), and nothing in the browser can widen
  it. Without that, `canvas serve` becomes a proxy into every service on the host's loopback. View
  guests get GET/HEAD only. Known gaps: no HMR (Vite's WebSocket needs a relay of its own),
  cookies (a service worker cannot see `Set-Cookie`), absolute `localhost` URLs in pages, and
  latency for unbundled dev servers. Needs an ADR of its own.
- **Pixel streaming**: the host captures its own frame (Element Capture) and streams it over
  trystero. Guests can't interact, Chrome only, and the host has to accept a capture prompt.
  Little security impact while it stays view-only; relaying input back would make it a remote
  control channel.
