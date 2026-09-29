import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleStop,
  ArrowDown,
  Layers,
  LoaderCircle,
  SendHorizontal,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AgentSettings } from "@/components/agent-settings";
import { MARKDOWN_LINKS, urlTransform } from "@/components/board-link";
import { CollabEditor } from "@/components/collab-editor";
import { FrameShell, StatusDot } from "@/components/frame-shell";
import { RemoteSelections } from "@/components/remote-selections";
import { Button } from "@/components/ui/button";
import { domSurface, useFollowScroll } from "@/hooks/use-follow-scroll";
import { promptText, updateFrame, type Frame } from "@/lib/board";
import { useRoom, useRoomState, useSession } from "@/lib/room-context";
import {
  foldThread,
  groupSteps,
  latestPlan,
  type Permission,
  type Row,
  type Steps,
  type Turn,
} from "@/lib/thread";
import { cn } from "@/lib/utils";
import { BOARD_SERVER_NAME, BOARD_TOOL_NAMES } from "../../shared/board-tools";
import type { PlanEntry } from "../../shared/protocol";

type AgentFrameData = Extract<Frame, { type: "agent" }>;

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
  const session = useSession(frame.id);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const text = useMemo(() => promptText(room.doc, frame.id), [room.doc, frame.id]);
  const status = session?.meta.status ?? "idle";
  const busy = status !== "idle" || sending;
  const agentLabel =
    room.roomState?.agents.find((a) => a.kind === frame.agent)?.label ?? frame.agent;
  const access = room.roomState?.access;

  const send = async () => {
    const prompt = text.toString().trim();
    if (!prompt || busy) return;
    setError(null);
    setSending(true);
    try {
      await room.act({ t: "agent-prompt", sessionId: frame.id, text: prompt });
      text.delete(0, text.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const hint = room.isHost
    ? "⌘↵ to send"
    : access === "view"
      ? "read-only"
      : access === "edit"
        ? "⌘↵ to ask the host to send"
        : "⌘↵ to send";

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        <>
          <span className="bg-secondary text-secondary-foreground rounded-md px-1.5 py-0.5 font-mono text-[11px]">
            {agentLabel}
          </span>
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
          frameId={frame.id}
          events={session?.events ?? []}
          version={session?.version ?? 0}
          loading={room.hostOnline && (session ? session.loading : !room.isHost)}
        />
        <Plan events={session?.events ?? []} version={session?.version ?? 0} />
        <div className="border-t">
          <CollabEditor
            text={text}
            readOnly={readOnly}
            placeholder={`Prompt ${agentLabel}… (write together — everyone sees this draft)`}
            onSubmit={send}
            className="max-h-40 min-h-16 overflow-auto"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <AgentSettings
              settings={session?.meta.settings}
              options={session?.options}
              known={room.isHost || !!session}
              disabled={readOnly || !room.hostOnline}
              onChange={(configId, value) =>
                room.act({ t: "agent-config", sessionId: frame.id, configId, value })
              }
            />
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
                onClick={() => void room.act({ t: "agent-cancel", sessionId: frame.id })}
                disabled={readOnly}
              >
                <CircleStop /> Stop
              </Button>
            )}
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
  );
}

function Thread({
  frameId,
  events,
  version,
  loading,
}: {
  frameId: string;
  events: Parameters<typeof foldThread>[0];
  version: number;
  /** The host has not sent the conversation yet. */
  loading: boolean;
}) {
  // `events` is appended in place; `version` is what changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const turns = useMemo(() => foldThread(events), [events, version]);
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
              <p className="text-muted-foreground py-8 text-center text-xs">
                No messages yet. Write a prompt below — the agent runs on the host's machine.
              </p>
            )
          )}
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} frameId={frameId} />
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

function TurnView({ turn, frameId }: { turn: Turn; frameId: string }) {
  return (
    <div className="space-y-2">
      <div
        className="bg-muted/60 border-l-[3px] px-2.5 py-2"
        style={{ borderLeftColor: turn.author.color }}
      >
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
          <StepsView key={item.key} steps={item} frameId={frameId} running={!turn.end} />
        ) : (
          <RowView key={item.key} row={item} frameId={frameId} />
        ),
      )}
      {turn.permissions.map((permission) => (
        <PermissionCard key={permission.requestId} permission={permission} frameId={frameId} />
      ))}
      {!turn.end && turn.rows.length === 0 && turn.permissions.length === 0 && (
        <p className="text-muted-foreground animate-pulse text-xs">thinking…</p>
      )}
      {turn.end?.error && <p className="text-destructive font-mono text-xs">{turn.end.error}</p>}
      {turn.end?.cancelled && <p className="text-muted-foreground font-mono text-xs">stopped</p>}
    </div>
  );
}

/** Several tool calls in a row, folded into one line: how many, and the last. */
function StepsView({
  steps,
  frameId,
  running,
}: {
  steps: Steps;
  frameId: string;
  running: boolean;
}) {
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
            <RowView key={row.key} row={row} frameId={frameId} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

function RowView({ row, frameId }: { row: Row; frameId: string }) {
  return <div data-row={row.kind}>{rowBody(row, frameId)}</div>;
}

function rowBody(row: Row, frameId: string) {
  switch (row.kind) {
    case "text":
      return (
        <div data-sel-key={row.key} className="prose-canvas text-sm">
          <Markdown remarkPlugins={REMARK} components={MARKDOWN_LINKS} urlTransform={urlTransform}>
            {row.content}
          </Markdown>
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
            <pre
              data-sel-key={row.key}
              className="bg-muted/60 max-h-60 overflow-auto p-2 font-mono text-[11px] whitespace-pre-wrap"
            >
              {row.args}
              {row.result !== undefined && `\n\n→ ${row.result}`}
            </pre>
          </Disclosure>
          {row.permissions.map((permission) => (
            <PermissionCard key={permission.requestId} permission={permission} frameId={frameId} />
          ))}
        </div>
      );
  }
}

/** A board tool as each agent names it (`mcp__canvas__open_frame`, `canvas_open_frame`). */
const REMARK = [remarkGfm];

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

function PermissionCard({ permission, frameId }: { permission: Permission; frameId: string }) {
  const room = useRoom();
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
              onClick={() => room.answerPermission(frameId, permission.requestId, option.optionId)}
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
