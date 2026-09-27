# 14 — Links to places on the board

Date: 2026-09-27 · `e2e/drive.ts` `STEP=links`, against a scratch repo, committed:

- `src/a.ts`: 200 lines `export const lineN = N; // line N`
- `src/b.ts`: 80 lines
- `docs/guide.md`: `## Part 1` … `## Part 11`, then `## Install`, with `[part 2](#part-2)` and
  `[…](../src/a.ts#L150)`
- `README.md`: a list of links: `[a.ts](src/a.ts)`, `[a.ts:120-125](src/a.ts#L120-L125)`,
  `[Install](docs/guide.md#install)`, `[Bottom](#bottom)`, inline code `` `src/b.ts:40` ``,
  `` `foo.bar` `` and `` `src/nope.ts:3` ``, `[example](https://example.com)`,
  `[index](pages/index.html)`. Then 60 filler paragraphs and `## Bottom`
- `pages/index.html`: links `#two` → `two.html`, `#code` → `../src/a.ts#L60`, `#web`,
  `#anchor` → `#down` (1500 px further down). A script posts `{canvasLink: "../src/b.ts"}` to the
  parent 800 ms after load, and calls `document.getElementById("code").click()` at 1200 ms
- `pages/two.html`: `#one` → `index.html`

Host and guest (edit access) in Chromium via Playwright. Decision: ADR 0007.

## Question

Can markdown links, and links in sandboxed HTML previews, take people to frames, files, lines,
headings and comments, without the page fragment that holds the room's secrets getting in the
way?

## Before (spike)

- **The fragment holds the secrets.** `readLink` reads `#k=…&pk=…&server=…&token=…` once, at
  load. A plain `href="#x"` replaces all of it. In a spike, clicking `[toc](#section)` in the app
  left `/?room=r#section` in the address bar. Nothing broke until a reload.
- **Markdown links were plain `<a>`s**, so an `https://` link in an agent reply navigated the
  board's own tab away. For the host that closes the door to the machine.
- **react-markdown 10 blanks unknown schemes** (`safeProtocol`: http(s), irc(s), mailto, xmpp),
  so `canvas:scratch/…` hrefs arrived empty. It takes a `urlTransform`.
- **Agents write `file_path:line_number`, mostly as inline code.** Claude Code's built-in prompt
  says so: "include the pattern file_path:line_number". Absolute paths are common. Every peer
  knows `cwd` (`roomState.cwd`).
- **A sandboxed srcdoc iframe can talk to the board.** A capture-phase click listener in the page
  posts `{canvasLink}`. On the board, `event.source === iframe.contentWindow` and
  `event.origin === "null"`. After a real click in the page, `navigator.userActivation.isActive`
  is true on the board. For a scripted post it is false. `target="_top"` stays blocked.

## What was built

- `web/lib/board-link.ts` (pure, tested): `parseLink(href, {cwd, file})` for markdown and HTML
  links, `parseCodeRef` for inline code, `readHash`/`formatHash`/`withTarget` for the fragment,
  and GitHub-style heading slugs.
- `web/lib/navigate.ts` (tested against a Y.Doc): which frame to use (the page's own, the link's,
  the nearest showing the file, else a new one beside the link's frame), what to retarget, then
  view, raise, focus and a reveal.
- `web/lib/reveal.ts`: a local store the views read. `CodeView` scrolls to the lines and makes
  them its selection, now a controlled `selectedLines`. `MarkdownPreview` scrolls to a
  `data-heading`.
- `hooks/use-board-navigation.ts`: `Go` for the board, `pushState` per place, `popstate`, and
  the deep link on load.
- `components/board-link.tsx`: react-markdown `a` and `code` components and chips. Each frame's
  shell sets the link scope, and a markdown preview sets its file. Agent threads, comments and
  previews all use them.
- `web/lib/link-bridge.ts`: the script HTML previews get, and the token check.

## Findings

- **The page's own scripts could fake a link, and focus plus user activation didn't stop it.**
  The first guard asked for the iframe to have focus and the board to have user activation. Page
  one's real click on `two.html`, then page two's `index.html`, loads a new page into the same
  iframe. It keeps focus, and the click's activation lasts about 5 s. So the page's post 800 ms
  after load passed, and the board jumped to `src/b.ts`. What holds: a random token per page,
  which the bridge keeps in a closure and removes its `<script>` before the page's scripts run,
  and `e.isTrusted`, so a script's `a.click()` is dropped. After that, the post at 800 ms and the
  fake click at 1200 ms both did nothing.
- **In-page anchors in srcdoc go to the board's URL.** `href="#down"` resolves against the
  parent's URL, so the browser loaded the web app into the preview. The app's scripts then
  failed CORS in the opaque origin. This was broken before links, too. The bridge now scrolls to
  the anchor itself. `scrollIntoView` also scrolled the board's own overflow-hidden containers,
  so the bridge uses `scrollTo` on the page's window.
- **A new frame isn't laid out when its reveal runs.** The first scroll estimate clamped to 0 and
  the line wasn't rendered. `scrollToLine` now retries each frame, for up to a second, until the
  line shows up. That fixed new frames and a guest's deep link, where the file arrives late.
- **The tree was only fetched for files frames**, so on a board of agent frames no file link could
  be checked. The host now watches it as soon as an agent frame exists.
- **A deep link like `#frame=<id>&lines=30-33` has no path.** It means lines of the file the
  frame shows.
- `@pierre/diffs` `File` takes a controlled `selectedLines`. Clicking and Shift-clicking line
  numbers still selects, through `onLineSelected`.

## Result

`STEP=links`: 16 checks pass.

- Inline code that names a file becomes a chip; other code stays code.
- A lines link opens `src/a.ts` beside the README, in source, with no shared `lines`. The lines
  become the host's selection, the host occupies the frame, and the URL keeps its secrets.
- A heading link scrolls the same file, or opens another file there. Back returns to the
  previous heading.
- A web link opens a tab, and the board stays.
- The page's posts and its fake click go nowhere, even right after a real click.
- `two.html` and back load in the page's own frame. An in-page anchor stays in the page, and
  `#code` selects line 60 of `a.ts`.
- A guest's deep link (`…&frame=<a.ts>&lines=30-33`) scrolls there and selects 30–33. The host
  occupies the frame, so the guest goes their own way in it.
