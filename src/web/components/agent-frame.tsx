import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleStop,
  CornerDownLeft,
  ArrowDown,
  ArrowLeft,
  Layers,
  LoaderCircle,
  SendHorizontal,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorView } from "@codemirror/view";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AgentSettings, ModeChip, useModeCycle } from "@/components/agent-settings";
import { TurnFooter, UsageRing } from "@/components/agent-usage";
import { MARKDOWN_LINKS, urlTransform } from "@/components/board-link";
import { CollabEditor } from "@/components/collab-editor";
import { ConversationMenu } from "@/components/conversation-menu";
import { CopyButton } from "@/components/copy-button";
import { FrameShell, StatusDot } from "@/components/frame-shell";
import { RemoteSelections } from "@/components/remote-selections";
import { Button } from "@/components/ui/button";
import { domSurface, useFollowScroll } from "@/hooks/use-follow-scroll";
import { promptText, shownSession, updateFrame, type Frame } from "@/lib/board";
import {
  useFrameSessions,
  useKindOptions,
  useRoom,
  useRoomState,
  useSession,
} from "@/lib/room-context";
import { backTo, conversations, type Conversation } from "@/lib/sessions";
import {
  foldThread,
  groupSteps,
  latestPlan,
  type Permission,
  type Row,
  type Steps,
  type Turn,
} from "@/lib/thread";
import { browse } from "@/lib/prompt-history";
import { cn } from "@/lib/utils";
import { settingsOf, withSettings } from "../../shared/agent-settings";
import { BOARD_SERVER_NAME, BOARD_TOOL_NAMES } from "../../shared/board-tools";
import type { AgentConfigValue, AgentEvent, PlanEntry } from "../../shared/protocol";

type AgentFrameData = Extract<Frame, { type: "agent" }>;

const NO_EVENTS: AgentEvent[] = [];

/** The session the frame shows: what its permission cards answer for. */
const ShownSession = createContext("");

export function AgentFrame({ frame, readOnly }: { frame: AgentFrameData; readOnly: boolean }) {
  const room = useRoomState();
  if (!frame.agent)
    return (
      <FrameShell frame={frame} readOnly={readOnly}>
        <AgentPicker frame={frame} readOnly={readOnly} />
      </FrameShell>
    );
  return <AgentThread frame={frame} readOnly={readOnly} room={room} />;
}

/** A new agent frame starts here: which agent runs it is picked once. */
function AgentPicker({ frame, readOnly }: { frame: AgentFrameData; readOnly: boolean }) {
  const room = useRoomState();
  const agents = room.roomState?.agents ?? [];
  const pick = (kind: string) =>
    updateFrame(room.doc, frame.id, {
      agent: kind,
      // `agent-3` becomes `claude-3`, unless someone already named it.
      title: frame.title.replace(/^agent-(\d+)$/, `${kind}-$1`),
    });
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-72 space-y-3">
        <h2 className="text-[11px] font-semibold tracking-wide uppercase">Choose an agent</h2>
        {readOnly ? (
          <p className="text-muted-foreground text-xs">No agent picked yet.</p>
        ) : agents.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {room.hostOnline ? "No agents are installed on the host." : "The host is offline."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {agents.map((agent) => (
              <button
                key={agent.kind}
                type="button"
                data-pick-agent={agent.kind}
                className="hover:bg-accent bg-background flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left"
                onClick={() => pick(agent.kind)}
              >
                <Bot className="text-muted-foreground size-4" />
                <span className="flex-1 text-sm font-medium">{agent.label}</span>
                <span className="text-muted-foreground font-mono text-[11px]">{agent.kind}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-muted-foreground text-xs leading-relaxed">
          It runs on the host's machine. Model and reasoning effort can be changed from the composer
          at any time.
        </p>
      </div>
    </div>
  );
}

function AgentThread({
  frame,
  readOnly,
  room,
}: {
  frame: AgentFrameData;
  readOnly: boolean;
  room: ReturnType<typeof useRoomState>;
}) {
  const sessionId = shownSession(frame);
  const session = useSession(sessionId);
  const kindOptions = useKindOptions(frame.agent);
  // Until its agent runs, the session's settings are what its kind offers,
  // with the values it last had, or (not begun) those the frame starts it with
  // (ADR 0012). The same while they read the same: a change waits for new
  // options as the agent's answer.
  const derived =
    kindOptions && withSettings(kindOptions, session ? session.meta.settings : frame.settings);
  const derivedKey = JSON.stringify(derived);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => derived, [derivedKey]);
  const options = session?.options ?? stable;
  const settings = session?.meta.settings ?? (options && settingsOf(options));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const text = useMemo(() => promptText(room.doc, frame.id), [room.doc, frame.id]);
  const events = session?.events ?? NO_EVENTS;
  const version = session?.version ?? 0;
  // `events` is appended in place; `version` is what changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const turns = useMemo(() => foldThread(events), [events, version]);
  const status = session?.meta.status ?? "idle";
  const busy = status !== "idle" || sending;
  const agentLabel =
    room.roomState?.agents.find((a) => a.kind === frame.agent)?.label ?? frame.agent;
  const access = room.access;
  const mine = useFrameSessions(frame.id);
  const list = useMemo(
    () => conversations(mine, sessionId, session?.meta),
    [mine, sessionId, session?.meta],
  );

  const send = async () => {
    const prompt = text.toString().trim();
    if (!prompt || busy) return;
    setError(null);
    setSending(true);
    try {
      await room.act({ t: "agent-prompt", sessionId, frameId: frame.id, text: prompt });
      text.delete(0, text.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  // ↑/↓: our own prompts of the conversation shown (`prompt-history.ts`).
  const browsing = useRef<number | null>(null);
  // What was about the conversation before isn't about this one.
  useEffect(() => {
    setError(null);
    browsing.current = null;
  }, [sessionId]);
  const recall = (view: EditorView, direction: "older" | "newer") => {
    const { doc, selection } = view.state;
    const line = doc.lineAt(selection.main.head).number;
    if (!selection.main.empty || line !== (direction === "older" ? 1 : doc.lines)) return false;
    const me = room.identity;
    const history = turns
      .filter((turn) => turn.author.name === me.name && turn.author.color === me.color)
      .map((turn) => turn.text);
    const step = browse(history, browsing.current, doc.toString(), direction);
    if (!step) {
      browsing.current = null;
      return false;
    }
    browsing.current = step.at;
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: step.text },
      selection: { anchor: direction === "older" ? 0 : step.text.length },
    });
    return true;
  };
  const composer = () => {
    const editor = document.querySelector<HTMLElement>(
      `[data-frame="${frame.id}"] [data-composer] .cm-editor`,
    );
    return editor ? EditorView.findFromDOM(editor) : null;
  };
  /** A prompt again, into the draft: as it is, or after what is there. */
  const reuse = (prompt: string) => {
    const view = composer();
    if (!view) return;
    const end = view.state.doc.length;
    const insert = view.state.doc.toString().trim() ? `\n\n${prompt}` : prompt;
    view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
    view.focus();
  };

  // Not while it runs: the first version keeps no conversation going unseen (ADR 0012).
  const startNew = () => {
    if (readOnly || busy) return;
    room.newConversation(frame.id);
    composer()?.focus();
  };
  const show = (id: string) => {
    if (!readOnly && !busy) room.showConversation(frame.id, id);
  };
  const back = !readOnly && !busy ? backTo(list) : undefined;

  const configure = (configId: string, value: AgentConfigValue) =>
    room.act({ t: "agent-config", sessionId, configId, value });
  const mode = useModeCycle(options, configure);
  const controls = readOnly || !room.hostOnline;

  const hint = room.isHost
    ? "⌘↵ to send"
    : access === "view"
      ? "read-only"
      : access === "edit"
        ? "⌘↵ to ask the host to send"
        : "⌘↵ to send";

  return (
    <ShownSession.Provider value={sessionId}>
      <FrameShell
        frame={frame}
        readOnly={readOnly}
        status={
          <>
            <ConversationMenu
              label={agentLabel}
              list={list}
              readOnly={readOnly}
              busy={busy}
              onNew={startNew}
              onShow={show}
            />
            {room.hostOnline && status === "waiting" ? (
              <NeedsHost frameId={frame.id} host={room.isHost} />
            ) : (
              <StatusDot status={room.hostOnline ? status : "offline"} />
            )}
          </>
        }
        attention={room.hostOnline && status === "waiting"}
      >
        <div className="flex h-full flex-col">
          <Thread
            key={sessionId}
            frameId={frame.id}
            turns={turns}
            onReuse={readOnly ? undefined : reuse}
            version={version}
            loading={room.hostOnline && (session ? session.loading : !room.sessionsKnown)}
            back={back}
            onBack={show}
          />
          <Plan events={events} version={version} />
          <div className="border-t" data-composer="">
            <CollabEditor
              text={text}
              readOnly={readOnly}
              placeholder={`Prompt ${agentLabel}… (write together — everyone sees this draft)`}
              onSubmit={send}
              keys={{
                "Shift-Tab": () => {
                  if (!controls) mode.cycle();
                  return true;
                },
                ArrowUp: (view) => recall(view, "older"),
                ArrowDown: (view) => recall(view, "newer"),
              }}
              className="max-h-40 min-h-16 overflow-auto"
            />
            <div className="flex items-center gap-2 px-2.5 pb-2">
              <AgentSettings
                settings={settings}
                options={options}
                known={room.isHost || !!session}
                disabled={controls}
                onChange={configure}
              />
              <ModeChip settings={settings} mode={mode} disabled={controls} />
              <span className="text-muted-foreground flex-1 truncate text-[11px]">
                {error ? (
                  <span className="text-destructive">{error}</span>
                ) : sending && !room.isHost && access === "edit" ? (
                  "waiting for the host to approve…"
                ) : (
                  hint
                )}
              </span>
              {status !== "idle" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void room.act({ t: "agent-cancel", sessionId })}
                  disabled={readOnly}
                >
                  <CircleStop /> Stop
                </Button>
              )}
              <UsageRing usage={session?.meta.usage} turns={turns} />
              <Button
                size="sm"
                onClick={() => void send()}
                disabled={readOnly || busy || !room.hostOnline}
              >
                <SendHorizontal /> Send
              </Button>
            </div>
          </div>
        </div>
      </FrameShell>
    </ShownSession.Provider>
  );
}

function Thread({
  frameId,
  turns,
  onReuse,
  version,
  loading,
  back,
  onBack,
}: {
  frameId: string;
  turns: ReadonlyArray<Turn>;
  /** Put a prompt into the draft again. */
  onReuse: ((prompt: string) => void) | undefined;
  version: number;
  /** The host has not sent the conversation yet. */
  loading: boolean;
  /** Empty, the conversation it may go back to. */
  back: Conversation | undefined;
  onBack: (sessionId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Scrolled away from the end, and whether more came since. */
  const [away, setAway] = useState<"no" | "yes" | "news">("no");

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    else setAway((was) => (was === "no" ? was : "news"));
  }, [version]);
  const toEnd = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  // After the pin above: following someone, their place wins.
  useFollowScroll(
    frameId,
    "thread",
    () => scroller.current && domSurface(scroller.current),
    version,
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        data-frame-body=""
        className="h-full overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setAway((was) => (pinned.current ? "no" : was === "no" ? "yes" : was));
        }}
      >
        <div data-sel-root={frameId} className="relative space-y-4 p-3 select-text">
          {loading ? (
            <p className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading the conversation…
            </p>
          ) : (
            turns.length === 0 && (
              <div className="text-muted-foreground space-y-2 py-8 text-center text-xs">
                <p>No messages yet. Write a prompt below — the agent runs on the host's machine.</p>
                {back && (
                  <button
                    type="button"
                    data-back-to={back.id}
                    className="hover:text-foreground mx-auto flex max-w-full items-center gap-1"
                    onClick={() => onBack(back.id)}
                  >
                    <ArrowLeft className="size-3 shrink-0" />
                    <span className="shrink-0">back to</span>
                    <span className="truncate font-medium">{back.title}</span>
                  </button>
                )}
              </div>
            )
          )}
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} onReuse={onReuse} />
          ))}
          <RemoteSelections frameId={frameId} version={version} />
        </div>
      </div>
      {away !== "no" && (
        <button
          type="button"
          data-to-latest={away}
          className={cn(
            "bg-card absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border px-2.5 py-1 text-xs shadow-md",
            away === "news" ? "text-foreground border-status-pending/60" : "text-muted-foreground",
          )}
          onClick={toEnd}
        >
          <ArrowDown className="size-3" />
          {away === "news" ? "New activity" : "Latest"}
        </button>
      )}
    </div>
  );
}

/**
 * The agent's latest plan, above the composer: what it is on, and what is
 * left. It stays until the agent sends another. Folding it is our own.
 */
function Plan({ events, version }: { events: Parameters<typeof latestPlan>[0]; version: number }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => latestPlan(events), [events, version]);
  const [open, setOpen] = useState(true);
  if (!plan?.length) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  const current = plan.find((entry) => entry.status === "in_progress");
  return (
    <div data-plan="" className="border-t text-xs">
      <button
        type="button"
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="text-[11px] font-semibold tracking-wide uppercase">Plan</span>
        <span className="font-mono text-[11px] tabular-nums">
          {done}/{plan.length}
        </span>
        {!open && current && <span className="truncate">· {current.content}</span>}
      </button>
      {open && (
        <ol className="max-h-32 space-y-0.5 overflow-y-auto px-2.5 pb-2">
          {plan.map((entry, i) => (
            <PlanItem key={i} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

function PlanItem({ entry }: { entry: PlanEntry }) {
  const Icon =
    entry.status === "completed" ? Check : entry.status === "in_progress" ? CircleDot : Circle;
  return (
    <li
      data-plan-status={entry.status}
      className={cn(
        "flex items-start gap-1.5 leading-snug",
        entry.status === "completed" && "text-muted-foreground line-through",
        entry.status === "in_progress" && "font-medium",
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3 shrink-0",
          entry.status === "in_progress" && "text-status-pending",
          entry.status === "completed" && "text-status-complete",
        )}
      />
      <span className="min-w-0">{entry.content}</span>
    </li>
  );
}

function TurnView({
  turn,
  onReuse,
}: {
  turn: Turn;
  onReuse: ((prompt: string) => void) | undefined;
}) {
  return (
    <div className="space-y-2">
      <div
        className="group/copy bg-muted/60 relative border-l-[3px] px-2.5 py-2"
        style={{ borderLeftColor: turn.author.color }}
      >
        <div className="absolute top-1 right-1 z-10 flex gap-1">
          {onReuse && (
            <button
              type="button"
              data-reuse=""
              title="Into the draft again, to edit and send"
              className="bg-card text-muted-foreground hover:text-foreground rounded-md border p-1 opacity-0 shadow-sm transition-opacity group-hover/copy:opacity-100 focus-visible:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onReuse(turn.text)}
            >
              <CornerDownLeft className="size-3" />
            </button>
          )}
          <CopyButton text={turn.text} title="Copy the prompt" inline />
        </div>
        <div
          className="mb-0.5 text-[11px] font-semibold tracking-wide uppercase"
          style={{ color: turn.author.color }}
        >
          {turn.author.name}
        </div>
        <p data-sel-key={`${turn.id}:prompt`} className="text-sm whitespace-pre-wrap">
          {turn.text}
        </p>
      </div>
      {groupSteps(turn.rows).map((item) =>
        item.kind === "steps" ? (
          <StepsView key={item.key} steps={item} running={!turn.end} />
        ) : (
          <RowView key={item.key} row={item} />
        ),
      )}
      {turn.permissions.map((permission) => (
        <PermissionCard key={permission.requestId} permission={permission} />
      ))}
      {turn.end?.error && <p className="text-destructive font-mono text-xs">{turn.end.error}</p>}
      {turn.end?.cancelled && <p className="text-muted-foreground font-mono text-xs">stopped</p>}
      <TurnFooter turn={turn} />
    </div>
  );
}

/** Several tool calls in a row, folded into one line: how many, and the last. */
function StepsView({ steps, running }: { steps: Steps; running: boolean }) {
  const tools = steps.rows.filter((row) => row.kind === "tool");
  const last = tools.at(-1)!;
  const errors = tools.filter((row) => row.isError).length;
  const busy = running && tools.some((row) => row.result === undefined);
  return (
    <div data-steps={steps.tools}>
      <Disclosure
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <Layers className="size-3 shrink-0" />
            <span className="shrink-0">{steps.tools} tool calls</span>
            <span className="truncate font-mono">· {toolLabel(last)}</span>
            <span
              className={cn(
                "shrink-0 font-mono",
                errors ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {busy ? "running" : errors ? `${errors} failed` : "done"}
            </span>
          </span>
        }
      >
        <div className="space-y-1.5">
          {steps.rows.map((row) => (
            <RowView key={row.key} row={row} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

function RowView({ row }: { row: Row }) {
  return <div data-row={row.kind}>{rowBody(row)}</div>;
}

function rowBody(row: Row) {
  switch (row.kind) {
    case "text":
      return (
        <div className="group/copy relative">
          <CopyButton text={row.content} title="Copy the message (markdown)" />
          <div data-sel-key={row.key} className="prose-canvas text-sm">
            <Markdown remarkPlugins={REMARK} components={MARKDOWN} urlTransform={urlTransform}>
              {row.content}
            </Markdown>
          </div>
        </div>
      );
    case "thinking":
      return (
        <Disclosure label="Reasoning">
          <p
            data-sel-key={row.key}
            className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap"
          >
            {row.content}
          </p>
        </Disclosure>
      );
    case "tool":
      return (
        <div className="space-y-1.5">
          <Disclosure
            label={
              <span className="flex min-w-0 items-center gap-1.5">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate font-mono">{toolLabel(row)}</span>
                <span
                  className={cn(
                    "font-mono",
                    row.isError ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {row.isError ? "error" : row.result === undefined ? "running" : "done"}
                </span>
              </span>
            }
          >
            <div className="group/copy relative">
              <CopyButton
                text={row.result ?? row.args}
                title={row.result === undefined ? "Copy the input" : "Copy the output"}
              />
              <pre
                data-sel-key={row.key}
                className="bg-muted/60 max-h-60 overflow-auto p-2 font-mono text-[11px] whitespace-pre-wrap"
              >
                {row.args}
                {row.result !== undefined && `\n\n→ ${row.result}`}
              </pre>
            </div>
          </Disclosure>
          {row.permissions.map((permission) => (
            <PermissionCard key={permission.requestId} permission={permission} />
          ))}
        </div>
      );
  }
}

const REMARK = [remarkGfm];

/** An agent's markdown: board links, and code blocks with a copy button. */
const MARKDOWN: Components = {
  ...MARKDOWN_LINKS,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

function CodeBlock({ children }: { children: React.ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative">
      <CopyButton get={() => pre.current?.textContent ?? ""} title="Copy the code" group="code" />
      <pre ref={pre}>{children}</pre>
    </div>
  );
}

/** A board tool as each agent names it (`mcp__canvas__open_frame`, `canvas_open_frame`). */

const BOARD_TOOL = new RegExp(
  `^(?:mcp__${BOARD_SERVER_NAME}__|${BOARD_SERVER_NAME}_)(${BOARD_TOOL_NAMES.join("|")})$`,
);

/**
 * A tool row's label. Rows are named by ACP tool kind (`other`, `read`, …);
 * the tool's own name arrives only as the call's title, first in `args`
 * (which some agents stream as several JSON objects back to back).
 */
function toolLabel(row: Extract<Row, { kind: "tool" }>): string {
  const title = /"title":"([^"]+)"/.exec(row.args)?.[1] ?? row.name;
  const board = BOARD_TOOL.exec(title);
  return board ? `${BOARD_SERVER_NAME} · ${board[1]}` : row.name;
}

function Disclosure({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex w-full min-w-0 items-center gap-1"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className="mt-1 pl-4">{children}</div>}
    </div>
  );
}

/**
 * The header's status while the agent waits on a permission: only the host
 * can answer it, so it says who is needed. A click scrolls to the ask.
 */
function NeedsHost({ frameId, host }: { frameId: string; host: boolean }) {
  const show = (event: React.MouseEvent) => {
    const frame = event.currentTarget.closest("[data-frame]");
    const ask = frame?.querySelector<HTMLElement>("[data-permission-pending]");
    const body = ask?.closest<HTMLElement>("[data-frame-body]");
    if (!ask || !body) return;
    // Not scrollIntoView: it would scroll the board, too.
    const offset = ask.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const scale = body.getBoundingClientRect().height / body.clientHeight || 1;
    body.scrollTop += offset / scale - body.clientHeight / 3;
  };
  return (
    <button
      type="button"
      data-needs-host={frameId}
      title={host ? "The agent asks for a permission: show it" : "The agent waits for the host"}
      className="bg-status-ready/15 text-status-ready border-status-ready/45 flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={show}
    >
      <ShieldAlert className="size-3 animate-pulse" />
      {host ? "needs you" : "needs host"}
    </button>
  );
}

function PermissionCard({ permission }: { permission: Permission }) {
  const room = useRoom();
  const sessionId = useContext(ShownSession);
  const resolved = permission.resolved;
  const chosen = permission.options.find((o) => o.optionId === resolved?.optionId);
  return (
    <div
      className="border-status-ready/45 bg-status-ready/10 border p-2.5"
      data-status="ready"
      data-permission-pending={resolved ? undefined : ""}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
        <ShieldAlert className="text-status-ready size-3.5" /> Permission
      </div>
      <p className="mb-2 font-mono text-xs break-all">{permission.title}</p>
      {resolved ? (
        <p className="text-muted-foreground text-xs">
          {chosen ? chosen.name : "Denied"} · by {resolved.by}
        </p>
      ) : room.isHost ? (
        <div className="flex flex-wrap gap-1.5">
          {permission.options.map((option) => (
            <Button
              key={option.optionId}
              data-permission-kind={option.kind}
              size="sm"
              variant={
                option.kind.startsWith("allow")
                  ? option.kind === "allow_once"
                    ? "default"
                    : "outline"
                  : "ghost"
              }
              onClick={() =>
                room.answerPermission(sessionId, permission.requestId, option.optionId)
              }
            >
              {option.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Waiting for the host to decide — this runs on their machine.
        </p>
      )}
    </div>
  );
}
