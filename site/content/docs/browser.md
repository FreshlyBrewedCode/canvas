---
title: Browser
description: A shared URL, loaded by each viewer's own browser.
section: Features
order: 7
---

A browser frame shows a web page. The URL is shared; the page is not: each viewer's own browser
loads it.

![A browser frame showing the project's dev server](./screenshots/browser.webp)

- **Change the URL** in the frame's address bar. Everyone's frame follows.
- **Reload** with the arrow next to it. Reloading is yours alone.
- A URL without a scheme gets `https://`, or `http://` for `localhost` and `127.0.0.1`.
- Only `http` and `https` URLs load.

## localhost

`localhost` (and `127.0.0.1`, `[::1]`, …) is the host's machine, so only the host's frame loads it.
Guests see a notice instead: their browser would load their own machine. For guests to see a dev
server, they need a URL their browser can reach, for example a tunnel the host sets up.

To show everyone a page an agent wrote, open the HTML file in a [files frame](/docs/files#views)
instead: it renders for everyone. Agents can also pass a page as a
[scratch file](/docs/board-tools#scratch-files), without writing it into the project.

## Limits

- Pages that forbid being framed (`X-Frame-Options`, `frame-ancestors`) stay blank.
- Scrolling inside the page is not shared.
