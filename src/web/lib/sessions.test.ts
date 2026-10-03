import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import type { AgentEvent, AgentSetting, SessionMeta } from "../../shared/protocol";
import {
  addFrame,
  allFrames,
  newConversation,
  showConversation,
  shownSession,
  updateFrame,
  type AgentFrame,
  type Frame,
} from "./board";
import {
  boardSessions,
  frameSessions,
  framesShowing,
  mergeLog,
  nextSettings,
  place,
  promptFrame,
  Releases,
  shownSessions,
  startIn,
  unbegunOptions,
  waitingFrames,
} from "./sessions";

const meta = (id: string, frameId: string, lastAt: number, extra: Partial<SessionMeta> = {}) =>
  ({ id, agent: "claude", status: "idle", frameId, createdAt: 0, lastAt, ...extra }) as SessionMeta;
const large: AgentSetting = { id: "model", name: "Model", value: "large", label: "Large" };
const high: AgentSetting = { id: "effort", name: "Effort", value: "high", label: "High" };

function board() {
  const doc = new Y.Doc();
  const a = addFrame(doc, { type: "agent", title: "claude-1", agent: "claude" });
  const b = addFrame(doc, { type: "agent", title: "claude-2", agent: "claude" });
  const file = addFrame(doc, { type: "file", title: "a.ts", path: "a.ts" });
  const agent = (id: string) => allFrames(doc).find((f) => f.id === id) as AgentFrame;
  return { doc, a, b, file, agent, frames: () => allFrames(doc) };
}

describe("which session a frame shows", () => {
  test("its own id's until it names another; a name that isn't a session id is ignored", () => {
    const { doc, a, agent } = board();
    expect(shownSession(agent(a))).toBe(a);
    showConversation(doc, a, "s-2");
    expect(shownSession(agent(a))).toBe("s-2");
    updateFrame(doc, a, { session: "../../etc/passwd" });
    expect(shownSession(agent(a))).toBe(a);
  });

  test("a new conversation: a fresh id, starting from the settings it is given", () => {
    const { doc, a, agent } = board();
    const id = newConversation(doc, a, [large]);
    expect(id).not.toBe(a);
    expect(agent(a)).toMatchObject({ session: id, settings: [large] });
    // Another new one, from nothing: the settings go too.
    const next = newConversation(doc, a, undefined);
    expect(agent(a).session).toBe(next);
    expect(agent(a).settings).toBeUndefined();
  });

  test("switching shows another session, and drops starting settings; only agent frames", () => {
    const { doc, a, file, agent, frames } = board();
    newConversation(doc, a, [large]);
    showConversation(doc, a, a);
    expect(shownSession(agent(a))).toBe(a);
    expect(agent(a).settings).toBeUndefined();
    showConversation(doc, file, "s1");
    expect(frames().find((f) => f.id === file)).not.toHaveProperty("session");
  });

  test("a new conversation starts from the settings of the one shown", () => {
    const { doc, a, agent } = board();
    // Begun: its own settings.
    expect(nextSettings(agent(a), meta(a, a, 1, { settings: [large, high] }))).toEqual([
      large,
      high,
    ]);
    // Not begun: the ones it was to start with.
    newConversation(doc, a, [high]);
    expect(nextSettings(agent(a), undefined)).toEqual([high]);
  });

  test("the first prompt begins a session as its frame says; a begun one keeps its own", () => {
    const { doc, a, agent } = board();
    expect(startIn(agent(a), false)).toEqual({ frameId: a, agent: "claude" });
    newConversation(doc, a, [large]);
    expect(startIn(agent(a), false)).toEqual({
      frameId: a,
      agent: "claude",
      settings: [{ id: "model", value: "large" }],
    });
    expect(startIn(agent(a), true)).toEqual({ frameId: a, agent: "claude" });
  });

  test("before it begins, a session shows its kind's options at its frame's values", () => {
    const { doc, a, agent } = board();
    const kind = [
      {
        id: "model",
        name: "Model",
        type: "select" as const,
        value: "small",
        choices: [
          { value: "small", name: "Small" },
          { value: "large", name: "Large" },
        ],
      },
    ];
    expect(unbegunOptions(undefined, agent(a))).toBeUndefined();
    expect(unbegunOptions(kind, agent(a))![0]!.value).toBe("small");
    newConversation(doc, a, [large]);
    expect(unbegunOptions(kind, agent(a))![0]!.value).toBe("large");
  });
});

describe("the board's sessions", () => {
  test("a frame lists those that began in it, the last active first; the board, all", () => {
    const metas = [meta("s1", "f1", 10), meta("s2", "f2", 30), meta("s3", "f1", 20)];
    expect(frameSessions(metas, "f1").map((m) => m.id)).toEqual(["s3", "s1"]);
    expect(frameSessions(metas, "f9")).toEqual([]);
    expect(boardSessions(metas).map((m) => m.id)).toEqual(["s2", "s3", "s1"]);
  });

  test("the sessions frames show, and the frames showing one", () => {
    const { doc, a, b, frames } = board();
    showConversation(doc, b, a);
    expect([...shownSessions(frames())]).toEqual([a]);
    expect(framesShowing(frames(), a).map((f) => f.id)).toEqual([a, b].sort());
    // A frame with no agent picked shows nothing.
    const c = addFrame(doc, { type: "agent", title: "agent-3", agent: "" });
    expect(shownSessions(frames()).has(c)).toBe(false);
  });
});

describe("needs you", () => {
  test("points at the frames showing a waiting session, else the frame of its turn", () => {
    const { doc, a, b, frames } = board();
    showConversation(doc, b, a);
    expect(waitingFrames(frames(), [{ id: a, frameId: a }]).sort()).toEqual([a, b].sort());
    // Shown nowhere: the frame its turn came from, if still there.
    showConversation(doc, a, "s-new");
    showConversation(doc, b, "s-other");
    expect(waitingFrames(frames(), [{ id: "s-old", frameId: b }])).toEqual([b]);
    expect(waitingFrames(frames(), [{ id: "s-old", frameId: "gone" }])).toEqual([]);
  });
});

describe("prompts go into what a frame shows", () => {
  test("from an agent frame, into the session it shows; nothing else", () => {
    const { doc, a, b, file, frames } = board();
    expect(promptFrame(frames(), a, a).id).toBe(a);
    expect(() => promptFrame(frames(), a, b)).toThrow("shows another conversation");
    expect(() => promptFrame(frames(), file, file)).toThrow("no such agent frame");
    expect(() => promptFrame(frames(), "gone", "gone")).toThrow("no such agent frame");
    const s = newConversation(doc, b, undefined)!;
    expect(promptFrame(frames(), b, s).id).toBe(b);
    expect(() => promptFrame(frames(), b, b)).toThrow("shows another conversation");
  });

  test("not from a frame whose agent isn't picked", () => {
    const doc = new Y.Doc();
    const c = addFrame(doc, { type: "agent", title: "agent-1", agent: "" });
    expect(() => promptFrame(allFrames(doc) as Frame[], c, c)).toThrow("no such agent frame");
  });
});

describe("agent processes stop when no frame shows their session", () => {
  test("idle ones at once, busy ones once their turn is over, none never begun", () => {
    const releases = new Releases();
    const status = new Map<string, "idle" | "running" | "waiting">([
      ["idle", "idle"],
      ["busy", "running"],
      ["asks", "waiting"],
    ]);
    const of = (id: string) => status.get(id);
    expect(releases.show(new Set(["idle", "busy", "asks", "new"]), of)).toEqual([]);
    expect(releases.show(new Set(), of)).toEqual(["idle"]);
    expect(releases.settle("busy", "running")).toBe(false);
    expect(releases.settle("busy", "idle")).toBe(true);
    // Once only.
    expect(releases.settle("busy", "idle")).toBe(false);
    expect(releases.settle("idle", "idle")).toBe(false);
  });

  test("a busy one shown again before its turn ends keeps running", () => {
    const releases = new Releases();
    const of = () => "running" as const;
    releases.show(new Set(["s"]), of);
    releases.show(new Set(), of);
    releases.show(new Set(["s"]), of);
    expect(releases.settle("s", "idle")).toBe(false);
  });
});

describe("a log that arrives in pieces", () => {
  const e = (n: number): AgentEvent => ({ kind: "chunk", turnId: "t", chunk: n });

  test("a live event goes at the end, is dropped if had, waits after a gap", () => {
    expect(place(3, 3)).toBe("append");
    expect(place(3, 1)).toBe("have");
    expect(place(3, 5)).toBe("gap");
  });

  test("the history first, then what came live continues it, in any order", () => {
    const live = [
      { index: 3, event: e(3) },
      { index: 1, event: e(1) },
      { index: 2, event: e(2) },
    ];
    expect(mergeLog([e(0), e(1)], live)).toEqual([e(0), e(1), e(2), e(3)]);
    // A gap the history doesn't fill: stops there, to be asked for again.
    expect(mergeLog([e(0)], [{ index: 2, event: e(2) }])).toEqual([e(0)]);
  });

  test("a history sent again replaces what was had, keeping what came after it", () => {
    // A guest had 0..3; the host's link came back with a history of 0..4 —
    // or of 0..2, sent before the last live ones: either way, 0..4.
    const had = [e(0), e(1), e(2), e(3)].map((event, index) => ({ index, event }));
    expect(mergeLog([e(0), e(1), e(2), e(3), e(4)], had)).toEqual([e(0), e(1), e(2), e(3), e(4)]);
    expect(mergeLog([e(0), e(1), e(2)], had)).toEqual([e(0), e(1), e(2), e(3)]);
  });
});
