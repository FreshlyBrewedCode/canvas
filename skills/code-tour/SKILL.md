---
name: code-tour
description: Give a code tour on the canvas board — a guided walk through how part of the codebase works, as one files frame people click through. Use when asked for a tour or walkthrough of code, how a feature works across files, or to onboard someone to an area.
---

A code tour is one files frame on the board whose list holds, in reading order: a guide (a
markdown scratch file), then the **stops** — project files at the lines that matter — and
optionally a diagram at the end. People click through it at their own pace; the thread only
points at it.

## Steps

1. **Find the stops.** Read the code until you can tell the story from entry point to effect.
   Pick 4–10 stops in the order a newcomer needs them, usually where it starts → the core → the
   edges. A stop is one file at a tight line range (roughly 5–40 lines): the function, the branch,
   the type that carries the idea. Only files git tracks can be shown; a stop in an ignored file
   gets described in the guide instead. Done when each stop's range is read from the file as it
   is now, and the stops tell the story without gaps.

2. **Write the guide**, `tour-<topic>.md`: a one-paragraph overview, then one short section per
   stop, numbered and titled like its list entry — what to look at in those lines, why it
   matters, and how it hands over to the next stop. Name functions and types; quote lines
   sparingly, the frame shows them. End with open questions or pitfalls if you found any.

3. **Draw it**, when the flow branches or spans several components: `tour-<topic>.html`, a
   single self-contained page (inline CSS and SVG or script) with boxes named like the stops.
   Skip it for a straight line of calls.

4. **Open the tour.** `view_board` first; retarget an existing tour frame on the same topic with
   `update_frame` rather than opening a second one. Otherwise one `open_frame` of type `file`
   whose `files` list is the whole tour, the guide first:

   ```json
   {
     "type": "file",
     "title": "Tour: login",
     "files": [
       { "display": "0 Guide.md", "name": "tour-login.md", "content": "…" },
       { "display": "1 Route/login.ts", "path": "src/routes/login.ts", "start_line": 12, "end_line": 30 },
       { "display": "2 Session/session.ts", "path": "src/auth/session.ts", "start_line": 5, "end_line": 22 },
       { "display": "3 Diagram.html", "name": "tour-login.html", "content": "…" }
     ]
   }
   ```

   Number the display names like the guide's sections, so people can match them; folders are
   worth it only for chapters of a long tour. Done when every stop in the list has its section
   in the guide and every section its stop.

5. **Reply briefly**: the tour's frame, how many stops, and the story in one or two sentences.
   The guide carries the explanation; the thread stays short.

## Walking people through it

When people ask to be walked through the tour ("next", "show stop 3"), `update_frame` the tour
frame to that stop's `path`, `start_line` and `end_line`, and explain it in your reply. Changing
the frame makes you its occupant for the turn, so everyone following scrolls with you.

## Revising

Follow-up questions often deserve a stop or a section. `write_board_file` with the guide's path
rewrites it in place. `update_frame` with `files` replaces the whole list, so send every entry,
the new one in its place. Name the guide and diagram there by their `canvas:scratch/` paths:
`content` would create new copies.
