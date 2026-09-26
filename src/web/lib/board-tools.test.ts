import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { GAP } from "../../shared/layout";
import { addFrame, allFrames, promptText, type Frame, type NewFrame } from "./board";
import { runBoardTool } from "./board-tools";

const AGENTS = [
  { kind: "claude", label: "Claude Code" },
  { kind: "opencode", label: "opencode" },
];

function board(...frames: NewFrame[]) {
  const doc = new Y.Doc();
  const ids = frames.map((frame) => addFrame(doc, frame));
  const self = ids[0]!;
  const run = (name: string, args: Record<string, unknown> = {}) =>
    runBoardTool({ doc, self, agents: AGENTS }, name, args).text;
  const touched = (name: string, args: Record<string, unknown> = {}) =>
    runBoardTool({ doc, self, agents: AGENTS }, name, args).frame;
  const frame = (id: string) => allFrames(doc).find((f) => f.id === id);
  const newest = () => allFrames(doc).find((f) => !ids.includes(f.id)) as Frame;
  return { doc, ids, self, run, touched, frame, newest };
}

const agent = (x: number, y: number): NewFrame => ({
  type: "agent",
  agent: "claude",
  title: "claude-1",
  x,
  y,
  w: 460,
  h: 620,
});
const file = (x: number, y: number, path: string, extra = {}): NewFrame => ({
  type: "file",
  path,
  title: path.split("/").at(-1)!,
  x,
  y,
  w: 720,
  h: 560,
  ...extra,
});

describe("view_board", () => {
  test("lists the agent's cluster by rows and summarises the others", () => {
    const { run, ids } = board(
      agent(0, 0),
      file(484, 0, "src/auth.ts", { lines: { start: 10, end: 40 } }),
      { type: "terminal", title: "shell-1", x: 0, y: 644, w: 640, h: 400 },
      file(5000, 0, "README.md"),
    );
    const text = run("view_board");
    expect(text).toContain(`row 1: [${ids[0]}] agent claude "claude-1" (you)`);
    expect(text).toContain(`[${ids[1]}] file "auth.ts" src/auth.ts L10-40`);
    expect(text).toContain(`row 2: [${ids[2]}] terminal "shell-1"`);
    expect(text).toContain(`1 other cluster`);
    expect(text).toContain(`[${ids[3]}] file "README.md"`);
    expect(text).toContain("claude (Claude Code)");
  });
});

describe("open_frame", () => {
  test("a file goes at the end of the agent's row, at the row's height, marked as its own", () => {
    const { run, newest, self } = board(agent(0, 0));
    const text = run("open_frame", { type: "file", path: "./src/auth.ts", start_line: 12 });
    expect(newest()).toMatchObject({
      type: "file",
      path: "src/auth.ts",
      title: "auth.ts",
      lines: { start: 12, end: 12 },
      origin: self,
      x: 460 + GAP,
      y: 0,
      h: 620,
    });
    expect(text).toContain("(opened by you)");
  });

  test("a scratch file opens like any file; content never lands in the board", () => {
    const { run, newest } = board(agent(0, 0));
    run("open_frame", { type: "file", path: "canvas:scratch/flow.html", content: "<p>x</p>" });
    expect(newest()).toMatchObject({
      type: "file",
      path: "canvas:scratch/flow.html",
      title: "flow.html",
    });
    expect(JSON.stringify(newest())).not.toContain("<p>x</p>");
  });

  test("next to another frame, on the side asked", () => {
    const { run, newest, ids } = board(agent(0, 0));
    run("open_frame", { type: "terminal", next_to: ids[0], side: "below" });
    expect(newest()).toMatchObject({ type: "terminal", x: 0, y: 620 + GAP });
  });

  test("an agent frame gets its agent and a prompt draft nobody has sent", () => {
    const { run, newest, doc } = board(agent(0, 0));
    run("open_frame", { type: "agent", agent: "opencode", draft: "review auth.ts" });
    const opened = newest();
    expect(opened).toMatchObject({ type: "agent", agent: "opencode", title: "opencode-2" });
    expect(promptText(doc, opened.id).toString()).toBe("review auth.ts");
  });

  test("refuses what it cannot open", () => {
    const { run } = board(agent(0, 0));
    expect(() => run("open_frame", { type: "agent", agent: "gpt" })).toThrow(/claude, opencode/);
    expect(() => run("open_frame", { type: "browser", url: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => run("open_frame", { type: "file" })).toThrow(/path/);
    expect(() => run("open_frame", { type: "file", path: "a", next_to: "nope" })).toThrow(
      /no frame nope/,
    );
  });
});

describe("update_frame", () => {
  test("retargets a file frame: new path, fresh title and lines", () => {
    const { run, frame, ids } = board(
      agent(0, 0),
      file(484, 0, "src/a.ts", { lines: { start: 1, end: 2 } }),
    );
    run("update_frame", { frame: ids[1], path: "src/b.ts" });
    expect(frame(ids[1]!)).toMatchObject({ path: "src/b.ts", title: "b.ts", lines: null });
    run("update_frame", { frame: ids[1], start_line: 5, end_line: 9 });
    expect(frame(ids[1]!)).toMatchObject({ lines: { start: 5, end: 9 } });
  });

  test("moves a frame next to another", () => {
    const { run, frame, ids } = board(agent(0, 0), file(3000, 0, "x.ts"));
    run("update_frame", { frame: ids[1], next_to: ids[0], side: "right" });
    expect(frame(ids[1]!)).toMatchObject({ x: 460 + GAP, y: 0, h: 620 });
  });

  test("refuses changes that don't fit the frame", () => {
    const { run, ids } = board(agent(0, 0), {
      type: "terminal",
      title: "t",
      x: 0,
      y: 700,
      w: 1,
      h: 1,
    });
    expect(() => run("update_frame", { frame: ids[1], path: "a.ts" })).toThrow(/file frames/);
    expect(() => run("update_frame", { frame: ids[1] })).toThrow(/nothing to change/);
  });
});

describe("file lists", () => {
  const list = [
    { display: "1 Overview.md", path: "canvas:scratch/auth.md" },
    { display: "Auth/session.ts", path: "src/auth/session.ts", start_line: 5, end_line: 9 },
    { display: "Auth/password.ts", path: "src/auth/password.ts" },
  ];

  test("open_frame with a list shows its first entry, and keeps the list", () => {
    const { run, newest } = board(agent(0, 0));
    run("open_frame", { type: "file", files: list, title: "Auth" });
    expect(newest()).toMatchObject({
      type: "file",
      title: "Auth",
      path: "canvas:scratch/auth.md",
      lines: null,
      files: [
        { display: "1 Overview.md", path: "canvas:scratch/auth.md" },
        { display: "Auth/session.ts", path: "src/auth/session.ts", lines: { start: 5, end: 9 } },
        { display: "Auth/password.ts", path: "src/auth/password.ts" },
      ],
    });
  });

  test("a path picks what the frame shows first", () => {
    const { run, newest } = board(agent(0, 0));
    run("open_frame", { type: "file", files: list, path: "src/auth/password.ts" });
    expect(newest()).toMatchObject({ path: "src/auth/password.ts", files: { length: 3 } });
  });

  test("view_board spells the list out, display → real path", () => {
    const { run } = board(agent(0, 0));
    run("open_frame", { type: "file", files: list, title: "Auth" });
    expect(run("view_board")).toContain(
      'list of 3: ["1 Overview.md" → canvas:scratch/auth.md, "Auth/session.ts" → src/auth/session.ts L5-9',
    );
  });

  test("update_frame replaces the list, moving off a file no longer on it; [] removes it", () => {
    const { run, frame, ids } = board(agent(0, 0), file(484, 0, "src/auth/password.ts"));
    run("update_frame", { frame: ids[1], files: list });
    expect(frame(ids[1]!)).toMatchObject({ path: "src/auth/password.ts", files: { length: 3 } });
    run("update_frame", { frame: ids[1], files: [{ display: "x.ts", path: "src/x.ts" }] });
    expect(frame(ids[1]!)).toMatchObject({ path: "src/x.ts", files: [{ display: "x.ts" }] });
    run("update_frame", { frame: ids[1], files: [] });
    expect(frame(ids[1]!)).toMatchObject({ path: "src/x.ts", files: null });
  });

  test("refuses lists the tree can't show", () => {
    const { run } = board(agent(0, 0));
    const open = (files: unknown) => () => run("open_frame", { type: "file", files });
    expect(
      open([
        { display: "a", path: "a.ts" },
        { display: "a", path: "b.ts" },
      ]),
    ).toThrow("twice");
    expect(
      open([
        { display: "A", path: "a.ts" },
        { display: "A/b", path: "b.ts" },
      ]),
    ).toThrow("a file and a folder");
    expect(open([{ display: "../a", path: "a.ts" }])).toThrow("not a display path");
    expect(open([{ display: "a" }])).toThrow("needs a path");
    expect(open("a.ts")).toThrow("list of entries");
  });
});

describe("the frame a call works on", () => {
  test("is the one opened or changed; looking and closing touch none", () => {
    const { touched, newest, ids } = board(
      agent(0, 0),
      file(484, 0, "a.ts"),
      file(3000, 0, "b.ts"),
    );
    expect(touched("open_frame", { type: "terminal" })).toBe(newest().id);
    expect(touched("update_frame", { frame: ids[1], start_line: 3 })).toBe(ids[1]);
    expect(touched("view_board")).toBeUndefined();
    expect(touched("close_frame", { frame: ids[2] })).toBeUndefined();
  });
});

describe("close_frame", () => {
  test("closes a frame and its row closes the gap; the agent's own frame stays", () => {
    const { run, frame, ids, self } = board(
      agent(0, 0),
      file(484, 0, "a.ts"),
      file(484 + 720 + GAP, 0, "b.ts"),
    );
    run("close_frame", { frame: ids[1] });
    expect(frame(ids[1]!)).toBeUndefined();
    expect(frame(ids[2]!)!.x).toBe(484);
    expect(() => run("close_frame", { frame: self })).toThrow(/your own frame/);
  });
});
