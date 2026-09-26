# 0005. Scratch files agents write, and file lists agents curate

## Status

Accepted, 2026-09-26 (prototype).

## Context

A file frame shows one file of the shared set (ADR 0002), and an agent can point it at any of
them (ADR 0003). Two things were missing:

- **Content that only belongs on the board.** A write-up of a feature, or a small HTML
  visualisation, had to be written into the project first. That leaves temp files in the
  project, which show up in `git status` and in the shared set.
- **Many files in one frame.** Asked to "show the files of the auth feature", an agent opened a
  frame per file. A tour of ten files meant ten frames.

ADR 0002 keeps file content out of the board doc so that a guest can't forge what others see.
Whatever an agent writes for the board has to keep that property.

## Decision

1. **Scratch files live with `canvas serve`, not in the board.** An agent passes content with a
   board tool call. `canvas serve` gets the call first (`board-mcp.ts`), writes the content to
   `.canvas/scratch/<name>` and relays the call to the host's browser with the path
   `canvas:scratch/<name>` in place of the content. From then on it is a file like any other: a
   frame's path names it, the host mirrors it, and markdown and HTML render (ADR 0004). The
   content never enters the board doc. The protocol has no write message, so only agents
   (through their tools) create or change scratch files. People read them.
2. **One flat namespace, names never taken twice.** Creating a scratch file whose name exists
   gets a suffix (`overview.md` → `overview-2.md`), and the tool result names the path the
   agent got. Overwriting is explicit (`write_board_file` with the path). Any agent may read,
   show or overwrite any scratch file. Scratch files are kept until someone deletes them from
   `.canvas/scratch/`. Text only, at most 1 MiB, like the shared set.
3. **A file list maps display paths to real paths.** A file frame may carry `files`: entries of
   `{display, path, lines?}`. `path` is a shared file or a scratch file. `display` is where the
   entry shows in the frame's tree, so an agent can build virtual folders and rename files.
   Display paths are unique in a list; each translates back to its real path. The tree keeps
   the agent's order: a folder sorts where its first entry is. An entry's lines, if any, show
   as a badge, and picking the entry opens the file at them.
4. **A list is a request, like a path.** It lives in the board doc, so any `edit` guest can
   change it. Every real path is still read through the shared set. `view` guests see the list
   (the paths are on the board anyway) but can't pick from it, and still get no full tree.
5. **Each viewer toggles between the list and all files.** The full tree selects the file the
   frame shows, so people see where a listed file lives. Scratch files appear there under
   `canvas:scratch/`.

## Consequences

- An agent can put a write-up, repo files and a visualisation in one frame, without touching
  the project.
- Scratch files pile up in `.canvas/scratch/`. Nothing collects them.
- A guest who prompts an agent can have it write scratch files. They are only text that
  everyone sees. HTML ones render in the sandbox of ADR 0004.
- An `edit` guest can list and rename any shared file in a list, so a display path can lie
  about where a file lives. The full tree and the status bar show the real path.
