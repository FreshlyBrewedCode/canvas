# 09 — Previews: localhost for the host, HTML files for everyone

Date: 2026-09-26 · `e2e/drive.ts` `STEP=preview` against a scratch git repo holding one
`page.html`, with a static server on the host's `127.0.0.1:5199`. Host "Karl" and guest "Ada"
(edit access) in separate browsers (Chromium via Playwright). Decision: ADR 0004.

## The problem

Browser frames load their URL in each viewer's browser, so a dev server on the host's machine
only showed for the host. For guests, the same `localhost` URL loaded their own machine. HTML
files an agent wrote could only be read as source.

## What was built

- `src/web/lib/browser-url.ts`: `browserTarget(url)` is `web`, `loopback` (with the host as
  written) or `invalid` (anything but http(s), or unparseable). `typedUrl(draft)` adds `http://`
  on loopback, `https://` otherwise.
- The browser frame loads `web` URLs for everyone and `loopback` URLs for the host only. Guests
  see "<host> is on the host's machine, so only the host sees it here". `invalid` URLs load
  nowhere.
- The files frame renders `.html`/`.htm` by default in an `<iframe srcdoc sandbox="allow-scripts">`.
  The preview/source toggle now applies to HTML too.
- The board tools' instructions tell agents that guests don't see localhost, and that an HTML file
  opened as a file frame renders, with its assets inlined.

## Evidence

`STEP=preview`: all 10 checks pass.

- `page.html` renders for host and guest. Its script runs and reports `storage blocked; parent
  blocked`: `localStorage` throws (opaque origin), and `parent.document` throws. The iframe's
  `sandbox` is exactly `allow-scripts`.
- The file changes on disk ("Hello preview" → "Hello again") and the guest's preview follows.
- A browser frame at `http://127.0.0.1:5199/` shows the page for the host. The guest's frame has
  no iframe, just the notice.
- The guest types `localhost:5199` into the address bar: the frame's URL becomes
  `http://localhost:5199` for both.
- The guest writes `javascript:alert(1)` straight into the board doc: neither frame has an
  iframe, and both show "Only http and https URLs load."
- Screenshots `60-preview-host.png` / `60-preview-guest.png`: the same board, with the dev server
  for the host and the notice for the guest.

Also unit-tested (`browser-url.test.ts`): `127.1`, `2130706433`, `[::ffff:127.0.0.1]` and
`app.localhost` count as loopback; `localhost.example.com`, `128.0.0.1` and LAN addresses don't.

## Notes

- Playwright init scripts run in every frame, sandboxed previews included. The harness's
  `localStorage` write had to tolerate the `SecurityError`.
- A Vite project's `index.html` also renders by default and shows nothing useful: its module
  script is a relative URL. The source is one click away. Defaulting HTML to source would lose
  the common case, a one-file page an agent wrote.
