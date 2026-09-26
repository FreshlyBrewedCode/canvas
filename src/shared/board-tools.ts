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
  "open_frame",
  "update_frame",
  "close_frame",
] as const;
export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

/** The MCP server's name, as agents prefix its tools (`mcp__canvas__…`, `canvas_…`). */
export const BOARD_SERVER_NAME = "canvas";

export type FrameKind = "file" | "browser" | "terminal" | "agent";
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

export interface OpenFrameArgs extends Placement, FileTarget {
  readonly type: FrameKind;
  readonly title?: string;
  readonly url?: string;
  readonly agent?: string;
  readonly draft?: string;
}

export interface UpdateFrameArgs extends Placement, FileTarget {
  readonly frame: string;
  readonly title?: string;
  readonly url?: string;
  readonly view?: "preview" | "source";
}

export interface CloseFrameArgs {
  readonly frame: string;
}

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
    description: "File path relative to the project root, e.g. src/auth/session.ts.",
  },
  start_line: { type: "integer", minimum: 1, description: "First line to show and highlight." },
  end_line: { type: "integer", minimum: 1, description: "Last highlighted line (inclusive)." },
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
    name: "open_frame",
    description:
      "Open a new frame on the board, in your own cluster unless placed next to another frame. " +
      "file: a project file (read-only, live), optionally at a line range which gets highlighted. " +
      "browser: a URL, loaded by each viewer's own browser. terminal: an idle shell people can " +
      "type into. agent: another agent session; `draft` pre-fills its prompt, a person sends it.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["file", "browser", "terminal", "agent"] },
        ...fileTarget,
        url: { type: "string", description: "browser: an http(s) URL." },
        agent: { type: "string", description: "agent: which agent runs it (see view_board)." },
        draft: { type: "string", description: "agent: a prompt draft for people to send." },
        title: { type: "string", description: "Frame title. Default: from what it shows." },
        ...placement,
      },
      required: ["type"],
    },
  },
  {
    name: "update_frame",
    description:
      "Change a frame: point a file frame at another file or line range, switch a markdown " +
      "or HTML file between preview and source, change a browser frame's URL, rename a frame, or move " +
      "it next to another frame.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Id of the frame to change." },
        ...fileTarget,
        view: { type: "string", enum: ["preview", "source"] },
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
];

/** The agent's standing context, sent as MCP server instructions. */
export function boardInstructions(frameId: string): string {
  return `You are running inside canvas: a shared, multiplayer board that people are looking at together, live. Its frames are coding-agent sessions, files of this project, browser previews and terminals. You are the agent in frame ${frameId}; people write prompts into it and read your replies there. Several people may prompt you.

Frames that sit close together form a cluster: people keep related work together that way, and your own cluster is your workspace. Within a cluster frames sit in rows; frames in a row share a height.

The ${BOARD_SERVER_NAME} tools let you see and change the board: ${BOARD_TOOL_NAMES.join(", ")}. Use them when showing something on the board helps the people you work with — e.g. asked to show the files relevant to a topic, open them as file frames at the relevant lines instead of pasting code. Don't use them when a plain answer is enough.

- Look first (view_board). Reuse or retarget a frame (update_frame) rather than open a duplicate.
- New frames go into your cluster by default; that is almost always right. Keep it to a handful per request.
- Don't change or close frames other people opened unless asked. Frames you opened are marked as yours.
- File frames are read-only and live: they show a file as it is on disk, so they follow your edits. Only files git doesn't ignore can be shown, never secrets.
- A terminal frame is an idle shell for people; you cannot type into it. Run commands with your own tools.
- An agent frame starts another agent. You can leave a draft prompt in it; only a person can send it.
- A browser frame loads its URL in each viewer's own browser, so localhost means their machine, not this one: only the host sees a localhost URL, guests get a notice.
- To show a page you wrote to everyone, open the HTML file as a file frame: it renders, scripts included, but relative links and assets (CSS, images, other scripts) don't load, so inline them.`;
}
