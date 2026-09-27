# 0006. Comments belong to a file frame, and find their lines by their text

## Status

Accepted, 2026-09-27 (prototype). Evidence in `docs/findings/13-comments.md`.

## Context

People reviewing code together on the board want to leave notes on lines, and have an agent read
and act on them later ("address the comments in that frame"). Agents should be able to leave
notes too. Three things shape the design:

- A file frame shows one file at a time, and people and agents change which one all the time.
- Files change under the notes. Agents edit them live, and file frames follow the disk (ADR 0002).
- The board doc is the only shared state guests can write. Edit guests' board updates reach
  everyone unchecked (ADR 0001); only the host's machine has the files.

## Decision

1. **Comments belong to the file frame.** Each file frame has its own map in the board doc,
   `comments:<frameId>`. A comment names its file (a shared or scratch file), its lines, the
   lines' text when it was written (its quote), a markdown body and its author: a person (name,
   colour and a per-browser id) or an agent (its frame). Comments stay while the frame shows
   other files. They go when the frame is removed. A new frame, including one opened with
   ⌘/Ctrl-click, starts without any. Flat notes only: no replies, no resolving.
2. **The quote finds the lines again.** When the file changes, a comment moves to the nearest
   place where its quoted lines read the same. If they are nowhere, the comment is **outdated**:
   it stays, shows above the file's first line with what its lines used to read, and comes back
   if they do. A quote of blank lines never moves, because finding it elsewhere would be a guess.
   Only the host writes these moves, and only for the file its frame shows, so peers never race
   to write the same change. Everyone places the comments against the text they have while the
   host's write is on its way.
3. **Only the source view shows comments.** The gutter's "+" writes one, on the hovered line or
   the selected lines. Picking a comment from the frame's header opens its file at its lines,
   which puts a markdown or HTML file into source.
4. **Who changes what.** Anyone who may edit the board comments. `view` guests read comments but
   can't write them. People edit and delete their own comments; the host can edit and delete
   everyone's. Agents edit and delete agents' comments, never people's. The web app enforces this,
   not the host: a board update isn't checked for what it changes (ADR 0001), so a forged client
   could change any comment, as it could change any frame.
5. **Agents read comments on request, and quote from the machine.** `view_board` counts a frame's
   comments; `view_frame` lists them with ids, authors, lines and, for outdated ones, the old
   lines. Agents aren't told when a comment is added. `add_comment` goes through `canvas serve`,
   which reads the quote from the shared set, so an agent names only a path and lines, and paths
   are checked as for frames (ADR 0002). `update_frame` with a comment id shows its file at its
   lines.

## Consequences

- A review survives switching files, and a later prompt ("address Karl's comments in [frame]")
  finds everything in one tool call.
- Comments on a file no frame shows aren't moved while nobody looks. They catch up when the file
  is shown again, because the quote still finds the lines.
- Quotes are part of the board doc, so the commented lines reach everyone on the board, even
  while no frame shows their file. They are lines of the shared set, which a frame would show
  anyway.
- "Your own comment" rests on an id in the browser's storage. A second browser is someone else.
