# 0007. Links go to places on the board, for the one who follows them

## Status

Accepted, 2026-09-27 (prototype). Evidence in `docs/findings/14-board-links.md`. Amends ADR 0004
(links in HTML previews).

## Context

Agents talk about frames, files and lines all the time. Their replies named them as text:
`src/auth/session.ts:42`, "the review frame". People then went looking. The same holds for
markdown files in the project, which link each other and their code, and for comments.

Links in markdown did worse than nothing. The renderers used plain `<a>` elements, so:

- a web link replaced the tab. For the host, that tab is the only door to the machine
  (ADR 0001), so everyone lost the host;
- `[toc](#section)` in a markdown preview replaced the page's fragment, which holds the room's
  secrets (`#k=…&pk=…&server=…&token=…`). The board kept running, but a reload left the room.

An HTML preview (ADR 0004) had no working links at all. Its srcdoc page resolves relative URLs
against the board's URL, so `two.html` or `#section` loaded the board's origin into the preview.

## Decision

1. **A link names a place.** It can name a frame, a file, lines, a markdown heading or a comment,
   or several of them. Files are written the way GitHub, editors and agents write them:
   `src/a.ts`, `src/a.ts#L10-L20`, `src/a.ts:42`, `docs/guide.md#install`,
   `canvas:scratch/x.md`, or an absolute path under the working dir. They are relative to the
   file the link is in, else to the working dir. Frames use the fragment's own `key=value` form:
   `#frame=<id>[&path=…][&lines=10-20][&heading=…][&comment=<id>]`. Anything that climbs out of
   the working dir, or has a scheme other than http(s) and mailto, links nowhere. All paths are
   still read through the shared set (ADR 0002).
2. **Links render as chips wherever markdown renders:** agent replies, comments and markdown
   previews. Inline code that names a file in the shared set, like `` `src/a.ts:42` `` as agents
   write it, is a chip too. Code that names no such file stays code. A link to a closed frame is
   struck through. Web links open in a new tab, never in the board's.
3. **Going somewhere is yours; what the board shows is shared.** A click works like pressing the
   frame and scrolling it. Your view moves to the frame. You occupy it if it is free (ADR 0003,
   finding 08). If someone else does, you stop following them there. Lines are scrolled to and
   become your selection; a heading is scrolled to. Neither changes the frame's own range. What a
   frame shows stays shared, as in the tree:
   - a file no frame shows opens in a new frame beside the link's frame;
   - if one frame or more shows it, the nearest is used;
   - a frame is pointed at a link's file;
   - lines put a markdown or HTML file into source, and a heading puts it into preview.

   `view` guests move and scroll but change nothing, so links to files that no frame shows don't
   work for them.
4. **Links are page history.** Each place a link took you is an entry: the room's secrets plus
   the place, e.g. `#k=…&pk=…&frame=abc&lines=3`. Back and Forward go between them, and a URL
   with a place is a deep link, followed once the board has what it names.
5. **HTML previews hand their links to the board.** Each page gets a script, first in its head,
   that turns a click on a link into a `postMessage` to the board and scrolls in-page anchors
   itself. The board follows the link like one in markdown, relative to the HTML file. A link
   to another HTML file opens in the same frame, so a few pages make a small site. The page's
   own scripts can post too. So a post only counts with a random token of that page, which the
   script keeps in a closure after removing its own element, and the script forwards only
   clicks a person made (`isTrusted`). The sandbox is unchanged.
6. **Agents are told how to link**, in their standing context (ADR 0003), and `view_board` gives
   them the frame ids.

## Consequences

- An agent's reply can take people straight to the code it talks about, and a write-up can link
  the files of a code tour.
- The host's browser now watches the file tree as soon as an agent frame is on the board, not
  only a files frame, so that links in replies can be checked.
- Following a link can change what a frame shows for everyone, as picking a file in its tree
  does. Following a link to lines of a markdown file others are reading in preview switches it
  to source for them.
- A link to a frame id is only as stable as the frame. Once it is closed, the chip is struck
  through.
- A page that loads right after a click can't use that click: its token and a trusted click are
  both needed. What a page can do with a click is what a link in markdown can do.
- A board URL can now hold a place after the secrets. Copying the host's address bar still
  copies the host link: the guest link is still the one to share.
- Relative assets (CSS, images, scripts) still don't load in HTML previews. That stays future work
  from ADR 0004.
