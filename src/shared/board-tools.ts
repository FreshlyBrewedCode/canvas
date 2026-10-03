/**
 * The tools an agent gets to see and change the board (finding 06), and the
 * priming that tells it what canvas is. `canvas serve` offers them over MCP;
 * the host's browser runs them against the board (`web/lib/board-tools.ts`).
 *
 * The priming goes out as MCP server instructions: every agent shows those to
 * its model next to — never instead of — its own system prompt, and none of
 * it enters the thread. It is static per session (Claude records the system
 * context once); what changes lives in tool results.
 */

export const BOARD_TOOL_NAMES = [
  "view_board",
  "view_frame",
  "open_frame",
  "update_frame",
  "close_frame",
  "read_board_file",
  "write_board_file",
  "add_comment",
  "edit_comment",
  "delete_comment",
  "draw",
] as const;
export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

/** The MCP server's name, as agents prefix its tools (`mcp__canvas__…`, `canvas_…`). */
export const BOARD_SERVER_NAME = "canvas";

export type FrameKind = "file" | "browser" | "terminal" | "agent" | "drawing";
export type PlaceSide = "left" | "right" | "above" | "below";

export interface ViewBoardArgs {
  readonly scope?: "cluster" | "board";
}

interface Placement {
  /** A frame id; the new or moved frame goes beside it. */
  readonly next_to?: string;
  readonly side?: PlaceSide;
}

interface FileTarget {
  readonly path?: string;
  readonly start_line?: number;
  readonly end_line?: number;
}

/** A new scratch file to show (ADR 0005); `canvas serve` turns it into a `path`. */
interface ScratchContent {
  readonly name?: string;
  readonly content?: string;
}

/** One entry of a file frame's list (ADR 0005): a file at a display path. */
export interface FileListEntry extends ScratchContent {
  readonly display: string;
  readonly path?: string;
  readonly start_line?: number;
  readonly end_line?: number;
}

interface FileList {
  readonly files?: ReadonlyArray<FileListEntry>;
}

/** What to draw (ADR 0009): the host's browser turns it into Excalidraw elements. */
interface DrawContent {
  /** Excalidraw element skeletons (`web/lib/drawing.ts` checks them). */
  readonly elements?: ReadonlyArray<Record<string, unknown>>;
  readonly mermaid?: string;
}

export interface OpenFrameArgs
  extends Placement, FileTarget, ScratchContent, FileList, DrawContent {
  readonly type: FrameKind;
  readonly title?: string;
  readonly url?: string;
  readonly agent?: string;
  readonly draft?: string;
}

export interface UpdateFrameArgs extends Placement, FileTarget, ScratchContent, FileList {
  readonly frame: string;
  readonly title?: string;
  readonly url?: string;
  readonly view?: "preview" | "source";
  /** A comment's id: show its file at its lines. */
  readonly comment?: string;
}

export interface ViewFrameArgs {
  readonly frame: string;
}

export interface AddCommentArgs {
  readonly frame: string;
  readonly path: string;
  readonly start_line: number;
  readonly end_line?: number;
  readonly body: string;
  /** The lines' text, which `canvas serve` adds (ADR 0006). */
  readonly quote?: string;
}

export interface EditCommentArgs {
  readonly frame: string;
  readonly comment: string;
  readonly body: string;
}

export interface DeleteCommentArgs {
  readonly frame: string;
  readonly comment: string;
}

export interface DrawArgs extends DrawContent {
  readonly frame: string;
  /** Ids of elements to remove. */
  readonly delete?: ReadonlyArray<string>;
  readonly clear?: boolean;
}

export interface CloseFrameArgs {
  readonly frame: string;
}

export interface ReadBoardFileArgs {
  readonly path: string;
}

export interface WriteBoardFileArgs extends ScratchContent {
  readonly path?: string;
}

/** Where scratch files live, as board paths name them. */
export const SCRATCH_PREFIX = "canvas:scratch/";

const placement = {
  next_to: {
    type: "string",
    description: "Id of a frame to place it beside. Default: in your own cluster.",
  },
  side: {
    type: "string",
    enum: ["right", "left", "below", "above"],
    description:
      "Side of `next_to`. right/left: same row, same height. below/above: a new row. Default right.",
  },
};

const fileTarget = {
  path: {
    type: "string",
    description:
      "File path relative to the project root, e.g. src/auth/session.ts, or a scratch file: " +
      "canvas:scratch/<name>.",
  },
  start_line: { type: "integer", minimum: 1, description: "First line to show and highlight." },
  end_line: { type: "integer", minimum: 1, description: "Last highlighted line (inclusive)." },
};

const scratchContent = {
  content: {
    type: "string",
    description:
      "Instead of path: the text of a new scratch file to show — content for this board only, " +
      "like a write-up or an HTML visualisation. canvas keeps it outside the project.",
  },
  name: {
    type: "string",
    description:
      "With content: the scratch file's name, e.g. auth-overview.md; its extension decides how " +
      "it shows. A taken name gets a suffix; the result says which path you got.",
  },
};

const fileList = {
  files: {
    type: "array",
    description:
      "file: a list of files for the frame's tree, for people to click through at their pace — " +
      "e.g. the files of one feature, with a write-up first. Each entry is a project file or a " +
      "scratch file at a display path you choose: make folders, rename, order it (a folder sorts " +
      "where its first entry is; no folders for a flat list). The frame shows path, else the " +
      "first entry. update_frame replaces the list; [] removes it.",
    items: {
      type: "object",
      properties: {
        display: {
          type: "string",
          description:
            'Where it shows in the tree, e.g. "1 Overview.md" or "Auth/session.ts". Unique.',
        },
        path: { type: "string", description: "A project file or canvas:scratch/<name>." },
        ...scratchContent,
        start_line: {
          type: "integer",
          minimum: 1,
          description: "Lines to open it at, shown as a badge.",
        },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["display"],
    },
  },
};

const idRef = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

const drawContent = {
  elements: {
    type: "array",
    description:
      "Excalidraw elements to add, in the drawing's coordinates (view_frame gives the extent of " +
      "what is there; y grows downwards). Shapes: rectangle, ellipse, diamond with x, y, width, " +
      "height and a label. Text: x, y, text. Arrows and lines: x, y and points relative to them; " +
      "an arrow between two shapes needs only start and end — the ids of shapes of this call or " +
      "already drawn — and is routed between them. Give an id of your own to connect to a shape " +
      "of the same call; an existing element's id replaces that element.",
    items: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["rectangle", "ellipse", "diamond", "text", "arrow", "line"],
        },
        id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        label: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          description: "A shape's or an arrow's text.",
        },
        text: { type: "string", description: "text: its text." },
        fontSize: { type: "number", description: "text: default 20." },
        points: {
          type: "array",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          description: "arrow, line: [[0,0],[dx,dy],…], relative to x, y.",
        },
        start: { ...idRef, description: "arrow: the shape it starts at." },
        end: { ...idRef, description: "arrow: the shape it points to." },
        strokeColor: { type: "string", description: "Hex, e.g. #e03131." },
        backgroundColor: { type: "string", description: "Hex; default transparent." },
        fillStyle: { type: "string", enum: ["solid", "hachure", "cross-hatch"] },
        strokeWidth: { type: "number", description: "1, 2 (default) or 4." },
        strokeStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
        roundness: {
          type: "object",
          properties: { type: { type: "number" } },
          description: "{type: 3}: rounded corners.",
        },
        link: { type: "string", description: "A URL, or a board link." },
      },
      required: ["type"],
    },
  },
  mermaid: {
    type: "string",
    description:
      "A mermaid flowchart, sequence or class diagram, turned into shapes and placed below what " +
      "is drawn. The easiest way to draw anything with more than a few boxes.",
  },
};

export const BOARD_TOOLS: ReadonlyArray<{
  readonly name: BoardToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}> = [
  {
    name: "view_board",
    description:
      "See what is on the canvas board: your own cluster row by row, and the other clusters. " +
      "Every frame is listed with its id, type, title and what it shows. Look before you add.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["cluster", "board"],
          description: "cluster (default): your cluster in full, others summarised. board: all.",
        },
      },
    },
  },
  {
    name: "view_frame",
    description:
      "Look at one frame in full. For a file frame: what it shows, its list of files, and its " +
      "comments — people's and agents' notes on lines of its files, with ids, authors and lines. " +
      "view_board says which frames have comments. For a drawing: an image of it, and its " +
      "elements with ids, labels, places and what arrows connect.",
    inputSchema: {
      type: "object",
      properties: { frame: { type: "string", description: "Id of the frame." } },
      required: ["frame"],
    },
  },
  {
    name: "open_frame",
    description:
      "Open a new frame on the board, in your own cluster unless placed next to another frame. " +
      "file: a project file (read-only, live), optionally at a line range which gets highlighted, " +
      "or a scratch file: content you pass, kept by canvas outside the project. A file frame can " +
      "also carry a list of files (files): one frame to click through, instead of many. " +
      "browser: a URL, loaded by each viewer's own browser. terminal: an idle shell people can " +
      "type into. agent: another agent session; `draft` pre-fills its prompt, a person sends it. " +
      "drawing: a whiteboard people sketch on together, optionally with elements or mermaid " +
      "to start it (see draw).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["file", "browser", "terminal", "agent", "drawing"] },
        ...fileTarget,
        ...scratchContent,
        ...fileList,
        url: { type: "string", description: "browser: an http(s) URL." },
        agent: { type: "string", description: "agent: which agent runs it (see view_board)." },
        draft: { type: "string", description: "agent: a prompt draft for people to send." },
        ...drawContent,
        title: { type: "string", description: "Frame title. Default: from what it shows." },
        ...placement,
      },
      required: ["type"],
    },
  },
  {
    name: "update_frame",
    description:
      "Change a frame: point a file frame at another file, line range or new scratch file " +
      "(content), give it a list of files or replace it (files), switch a markdown " +
      "or HTML file between preview and source, change a browser frame's URL, rename a frame, or move " +
      "it next to another frame.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the frame to change." },
        ...fileTarget,
        ...scratchContent,
        ...fileList,
        view: { type: "string", enum: ["preview", "source"] },
        comment: {
          type: "string",
          description: "file: a comment's id (view_frame) — show its file at its lines.",
        },
        url: { type: "string" },
        title: { type: "string" },
        ...placement,
      },
      required: ["frame"],
    },
  },
  {
    name: "close_frame",
    description:
      "Remove a frame from the board. Only close frames you opened, unless someone asks you to.",
    inputSchema: {
      type: "object",
      properties: { frame: { type: "string", description: "Id of the frame to close." } },
      required: ["frame"],
    },
  },
  {
    name: "read_board_file",
    description:
      "Read a scratch file (canvas:scratch/<name>), e.g. one another agent wrote. view_board " +
      "lists them.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "canvas:scratch/<name>" } },
      required: ["path"],
    },
  },
  {
    name: "write_board_file",
    description:
      "Write a scratch file without opening a frame. With name: a new one. With path: overwrite " +
      "an existing one (any agent's); every frame showing it updates. Show a new one with " +
      "open_frame (path).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "canvas:scratch/<name> to overwrite." },
        name: scratchContent.name,
        content: { type: "string", description: "The file's full text." },
      },
      required: ["content"],
    },
  },
  {
    name: "add_comment",
    description:
      "Comment on lines of a file, in a file frame: it shows below the lines for everyone, " +
      "whatever file the frame shows. Markdown. The frame keeps it; people read it there.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the file frame." },
        path: {
          type: "string",
          description: "The file, relative to the project root, or canvas:scratch/<name>.",
        },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1, description: "Default: start_line." },
        body: { type: "string", description: "The comment, markdown." },
      },
      required: ["frame", "path", "start_line", "body"],
    },
  },
  {
    name: "edit_comment",
    description: "Rewrite a comment's text. Only agents' comments: people's are theirs.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the file frame." },
        comment: { type: "string", description: "The comment's id (view_frame)." },
        body: { type: "string", description: "The new text, markdown." },
      },
      required: ["frame", "comment", "body"],
    },
  },
  {
    name: "delete_comment",
    description: "Remove a comment. Only agents' comments: people's are theirs.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the file frame." },
        comment: { type: "string", description: "The comment's id (view_frame)." },
      },
      required: ["frame", "comment"],
    },
  },
  {
    name: "draw",
    description:
      "Change a drawing frame: add elements, a mermaid diagram, replace elements (an element with " +
      "an existing id), remove elements (delete) or everything (clear). Look at it first " +
      "(view_frame): people may have drawn there. Everyone sees the change live.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the drawing frame." },
        ...drawContent,
        delete: {
          type: "array",
          items: { type: "string" },
          description: "Ids of elements to remove (view_frame lists them); labels go with shapes.",
        },
        clear: { type: "boolean", description: "Remove everything first." },
      },
      required: ["frame"],
    },
  },
];

/** The agent's standing context, sent as MCP server instructions. */
export function boardInstructions(
  skills: ReadonlyArray<{ readonly name: string; readonly description: string }> = [],
): string {
  // No frame id here: a conversation can move between frames, and these are
  // read once. view_board says which frame is "you" now (ADR 0012, decision 3).
  return `You are running inside canvas: a shared, multiplayer board that people are looking at together, live. Its frames are coding-agent sessions, files of this project, browser previews, terminals and drawings. You are the agent in an agent frame: the one your latest prompt was sent from, which view_board marks as "you". People write prompts into it and read your replies there. Several people may prompt you.

Frames that sit close together form a cluster: people keep related work together that way, and your own cluster is your workspace. Within a cluster frames sit in rows; frames in a row share a height.

The ${BOARD_SERVER_NAME} tools let you see and change the board: ${BOARD_TOOL_NAMES.join(", ")}. Use them when showing something on the board helps the people you work with — e.g. asked to show the files relevant to a topic, show them on the board (one file, or a list of them) at the relevant lines instead of pasting code. Don't use them when a plain answer is enough.

- Look first (view_board). Reuse or retarget a frame (update_frame) rather than open a duplicate.
- New frames go into your cluster by default; that is almost always right. Keep it to a handful per request.
- Don't change or close frames other people opened unless asked. Frames you opened are marked as yours.
- File frames are read-only and live: they show a file as it is on disk, so they follow your edits. Only files git doesn't ignore can be shown, never secrets.
- A terminal frame is an idle shell for people; you cannot type into it. Run commands with your own tools.
- An agent frame starts another agent. You can leave a draft prompt in it; only a person can send it.
- A browser frame loads its URL in each viewer's own browser, so localhost means their machine, not this one: only the host sees a localhost URL, guests get a notice.
- Scratch files hold what exists only to be shown on this board: a write-up, a diagram, an HTML visualisation. Pass the text as \`content\` (with a \`name\`) to open_frame or update_frame, or use write_board_file; canvas keeps them outside the project, as canvas:scratch/<name>. Don't write such files into the project for the board. Anything else — a temp file for your own work, a script, test data — goes wherever it would without canvas.
- Any agent may read (read_board_file) and overwrite (write_board_file) any scratch file; view_board lists them.
- To show several files for one topic, prefer one file frame with a list (files) over a frame per file: people click through it at their own pace. You decide the tree: display paths, folders, order, line ranges. A write-up (a scratch file) at the top and a visualisation at the bottom fit in the same list.
- People (and agents) comment on lines of files in a file frame. view_board says which frames have comments; view_frame lists them, with ids. You aren't told when someone comments: look when asked to, e.g. to address feedback. add_comment leaves one of yours; edit_comment and delete_comment change agents' comments, never people's. update_frame with a comment's id shows its file at its lines. A comment is "outdated" when its lines changed since; it shows what they were.
- A drawing frame is an Excalidraw whiteboard people sketch on together. view_frame shows it to you as an image, with its elements as text; draw adds shapes, text, arrows or a mermaid diagram, changes or removes elements. Use one to sketch an architecture or a flow with people, or when asked to draw; a mermaid flowchart is quickest for more than a few boxes. People's sketches in it are theirs: add next to them, don't redraw them unless asked.
- Markdown and HTML files render. HTML runs its scripts, but relative assets (CSS, images, other scripts) don't load, so inline them. Links do work (see below).

Your replies, comments, markdown and HTML can link to places on the board with ordinary markdown links (or <a href> in HTML). A click takes that person there, opening a file frame if no frame shows the file:
- A file, from the project root: [session.ts](src/auth/session.ts); lines of it: [session.ts:42-60](src/auth/session.ts#L42-L60); a markdown heading: [Setup](docs/guide.md#setup); a scratch file: [overview](canvas:scratch/overview.md). \`path:line\` in inline code becomes a link too, if the file exists.
- A frame, by its id from view_board: [the review](#frame=<id>); a file or lines in it: #frame=<id>&path=src/a.ts&lines=10-20; a comment: #frame=<id>&comment=<comment id>.
- In a markdown or HTML file, relative paths are from that file. HTML pages can link each other: a link to another HTML file opens in the same frame, so several scratch pages make a small site.
Link to what you talk about when it's on the board or in the project; don't link to everything.${skillsSection(skills)}`;
}

/** canvas's own skills: the agent lists them, but may have dropped their descriptions. */
function skillsSection(
  skills: ReadonlyArray<{ readonly name: string; readonly description: string }>,
): string {
  if (skills.length === 0) return "";
  const list = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `\n\ncanvas also gives you skills for work on the board. When one fits the request, load it with your skill tool before you start:\n${list}`;
}
