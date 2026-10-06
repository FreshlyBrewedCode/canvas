import { Bell, Check, Clock, ShieldAlert } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { useGo } from "@/components/board-link";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFrames } from "@/hooks/use-doc";
import type { Knock } from "@/lib/admission";
import { arrivals, notices, type Notice } from "@/lib/notices";
import type { Approval, OwnRequest } from "@/lib/room";
import {
  useApprovals,
  useKnocks,
  useRequests,
  useRoom,
  useRoomState,
  useWaitingFrames,
} from "@/lib/room-context";
import { cn } from "@/lib/utils";
import { readableFull } from "../../shared/identity";
import type { AgentConfigOption, AgentConfigValue } from "../../shared/protocol";

/**
 * What waits on someone (`notices.ts`), in one place: the top bar's inbox,
 * and cards over the board announcing knocks and guests' requests as they
 * come, until answered or put off for later.
 */

interface InboxState {
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** Notices whose card was put off: they wait in the inbox only. */
  readonly later: ReadonlySet<string>;
  putOff(id: string): void;
}

const InboxContext = createContext<InboxState | null>(null);

function useInbox(): InboxState {
  const inbox = useContext(InboxContext);
  if (!inbox) throw new Error("useInbox outside an InboxProvider");
  return inbox;
}

/** Every notice of the room, as `notices` derives them. */
export function useNotices(): Notice[] {
  const room = useRoomState();
  const knocks = useKnocks();
  const approvals = useApprovals();
  const requests = useRequests();
  const waitingIds = useWaitingFrames();
  const frames = useFrames(room.doc);
  const { isHost, hostOnline, access } = room;
  return useMemo(() => {
    // Agents wait for the host: while it isn't here, nobody can answer them.
    const waiting = hostOnline
      ? frames
          .filter((frame) => waitingIds.has(frame.id))
          .map((frame) => ({ id: frame.id, title: frame.title }))
      : [];
    return notices({ isHost, knocks, approvals, waiting, requests, access });
  }, [isHost, hostOnline, access, knocks, approvals, requests, waitingIds, frames]);
}

export function InboxProvider({ children }: { children: ReactNode }) {
  const all = useNotices();
  const [open, setOpen] = useState(false);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  // A notice that is over leaves `later` too: should it come back (a peer knocks again), it is new.
  const ids = all.map((n) => n.id).join(" ");
  const [idsBefore, setIdsBefore] = useState(ids);
  if (ids !== idsBefore) {
    setIdsBefore(ids);
    const now = new Set(all.map((n) => n.id));
    if ([...later].some((id) => !now.has(id)))
      setLater(new Set([...later].filter((id) => now.has(id))));
  }
  const putOff = useCallback((id: string) => setLater((prev) => new Set(prev).add(id)), []);
  const value = useMemo(() => ({ open, setOpen, later, putOff }), [open, later, putOff]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

/** The top bar's inbox: a count of what waits, and the list of it. */
export function Inbox() {
  const room = useRoomState();
  const all = useNotices();
  const { open, setOpen } = useInbox();
  const count = all.length;
  const label = room.isHost ? "Needs you" : "Waiting on the host";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-inbox=""
          data-count={count}
          aria-label={count ? `${label} (${count})` : label}
          title={label}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium",
            count && room.isHost
              ? "bg-status-ready/15 text-status-ready border-status-ready/45"
              : "text-muted-foreground hover:bg-muted/60 border-transparent",
          )}
        >
          <Bell className={cn("size-3.5", count > 0 && room.isHost && "animate-pulse")} />
          {count > 0 && <span className="font-mono">{count}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-3 text-xs" data-inbox-list="">
        <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase">
          {label}
        </h3>
        {count === 0 ? (
          <p className="text-muted-foreground leading-relaxed">
            {room.isHost
              ? "Nothing waits on you. Knocks, guests' requests and agents asking for a permission show here."
              : "Nothing waits on the host."}
          </p>
        ) : (
          <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
            {all.map((notice) => (
              <li key={notice.id}>
                <NoticeView notice={notice} onGo={() => setOpen(false)} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Host: the cards over the board announcing knocks and guests' requests (`arrivals`). */
export function Arrivals() {
  const all = useNotices();
  const { open, setOpen, later, putOff } = useInbox();
  const { cards, more } = arrivals(all, later);
  // The inbox shows them all while open: no second set of buttons.
  if (open || (!cards.length && !more)) return null;
  return (
    <div data-hud="" data-arrivals="" className="absolute top-3 right-3 flex w-80 flex-col gap-2">
      {cards.map((notice) => (
        <NoticeView key={notice.id} notice={notice} card onLater={() => putOff(notice.id)} />
      ))}
      {more > 0 && (
        <button
          type="button"
          className="bg-card text-muted-foreground hover:text-foreground self-end rounded-md border px-2 py-1 text-xs shadow-sm"
          onClick={() => setOpen(true)}
        >
          {more} more in the inbox
        </button>
      )}
    </div>
  );
}

function NoticeView({
  notice,
  card,
  onLater,
  onGo,
}: {
  notice: Notice;
  /** Over the board, rather than in the inbox's list. */
  card?: boolean;
  onLater?: () => void;
  onGo?: () => void;
}) {
  switch (notice.kind) {
    case "knock":
      return <KnockCard knock={notice.knock} card={card} onLater={onLater} />;
    case "approval":
      return <ApprovalCard approval={notice.approval} card={card} onLater={onLater} />;
    case "agent":
      return <AgentWaits frame={notice.frame} onGo={onGo} />;
    case "request":
      return <RequestWaits request={notice.request} />;
  }
}

function Shell({
  color,
  card,
  onLater,
  children,
  ...data
}: {
  color: string;
  card?: boolean;
  /** Puts the card off: it stays in the inbox. */
  onLater?: () => void;
  children: ReactNode;
  [data: `data-${string}`]: string;
}) {
  return (
    <div
      {...data}
      data-status="ready"
      className={cn(
        "bg-card border-status-ready/45 relative border border-l-[3px] p-3",
        card ? "shadow-md" : "rounded-sm",
      )}
      style={{ borderLeftColor: color }}
    >
      {onLater && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground absolute top-1.5 right-1.5"
          aria-label="Later"
          title="Later: hide this card, it waits in the inbox"
          onClick={onLater}
        >
          <Clock />
        </Button>
      )}
      {children}
    </div>
  );
}

/** Host: someone knocks. Their whole fingerprint, so two browsers can be told apart. */
function KnockCard({
  knock,
  card,
  onLater,
}: {
  knock: Knock;
  card?: boolean;
  onLater?: () => void;
}) {
  const room = useRoom();
  return (
    <Shell
      color={knock.color}
      card={card}
      onLater={onLater}
      data-knock={knock.name}
      data-fingerprint={knock.fingerprint}
    >
      <p className="mb-1 pr-6 text-xs">
        <span className="font-semibold" style={{ color: knock.color }}>
          {knock.name}
        </span>{" "}
        wants to join
      </p>
      <p
        className="text-muted-foreground mb-2 font-mono text-[11px] break-words"
        title="This browser's fingerprint: ask them what theirs shows"
      >
        {readableFull(knock.fingerprint)}
      </p>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => room.deny(knock.peerId)}>
          Deny
        </Button>
        <Button size="sm" variant="outline" onClick={() => room.admit(knock.peerId, "view")}>
          Admit to view
        </Button>
        <Button size="sm" onClick={() => room.admit(knock.peerId, "edit")}>
          Admit to edit
        </Button>
      </div>
    </Shell>
  );
}

/** Host: a guest asks to run something on our machine. */
function ApprovalCard({
  approval,
  card,
  onLater,
}: {
  approval: Approval;
  card?: boolean;
  onLater?: () => void;
}) {
  const room = useRoom();
  const { request, peer } = approval;
  const what =
    request.t === "agent-prompt"
      ? "wants to send a prompt"
      : request.t === "agent-config"
        ? `wants to set ${describeConfig(room.optionsFor(request.sessionId, request), request)}`
        : request.t === "term-input"
          ? "wants to type in a terminal"
          : "wants to stop an agent";
  return (
    <Shell color={peer.color} card={card} onLater={onLater} data-approval={peer.name}>
      <p className="mb-1 pr-6 text-xs">
        <span className="font-semibold" style={{ color: peer.color }}>
          {peer.name}
        </span>{" "}
        {what}
      </p>
      {request.t === "agent-prompt" && (
        <p className="bg-muted/60 mb-2 max-h-32 overflow-auto p-2 text-xs whitespace-pre-wrap">
          {request.text}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => approval.resolve(false)}>
          Decline
        </Button>
        <Button size="sm" onClick={() => approval.resolve(true)}>
          <Check /> Run on my machine
        </Button>
      </div>
    </Shell>
  );
}

/** "Model to Sonnet 5", from the option list the host has for the session. */
function describeConfig(
  options: ReadonlyArray<AgentConfigOption> | undefined,
  request: { configId: string; value: AgentConfigValue },
) {
  const option = options?.find((o) => o.id === request.configId);
  const value =
    typeof request.value === "boolean"
      ? request.value
        ? "on"
        : "off"
      : (option?.choices.find((c) => c.value === request.value)?.name ?? request.value);
  return `${option?.name ?? request.configId} to ${value}`;
}

/** An agent blocked on a permission: answered in its frame, so this goes there. */
function AgentWaits({ frame, onGo }: { frame: { id: string; title: string }; onGo?: () => void }) {
  const room = useRoomState();
  const go = useGo();
  return (
    <div data-waiting={frame.id} className="flex items-center gap-2 rounded-sm border p-2">
      <ShieldAlert className="text-status-ready size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{frame.title}</span>{" "}
        {room.isHost ? "asks for a permission" : "waits for the host's permission"}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          onGo?.();
          go({ kind: "board", target: { frame: frame.id } });
        }}
      >
        Go there
      </Button>
    </div>
  );
}

/** Guest: something of ours the host hasn't answered yet. */
function RequestWaits({ request }: { request: OwnRequest }) {
  const room = useRoom();
  const { request: r } = request;
  const what =
    r.t === "agent-prompt"
      ? "Your prompt"
      : r.t === "agent-config"
        ? `Setting ${describeConfig(room.optionsFor(r.sessionId, r), r)}`
        : r.t === "term-input"
          ? "Typing in a terminal"
          : "Stopping an agent";
  return (
    <div data-request={r.t} className="flex items-start gap-2 rounded-sm border p-2">
      <Clock className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {what} waits for the host to approve it.
        {r.t === "agent-prompt" && (
          <span className="text-muted-foreground mt-1 line-clamp-2 block whitespace-pre-wrap">
            {r.text}
          </span>
        )}
      </span>
    </div>
  );
}
