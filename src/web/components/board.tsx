import {
  Bot,
  Check,
  FileCode,
  Globe,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AgentFrame } from "@/components/agent-frame";
import { ConnectionIndicator } from "@/components/connection-dialog";
import { GoProvider } from "@/components/board-link";
import { BrowserFrame } from "@/components/browser-frame";
import { FileFrame } from "@/components/file-frame";
import { TerminalFrame } from "@/components/terminal-frame";
import { Button } from "@/components/ui/button";
import { useBoardNavigation } from "@/hooks/use-board-navigation";
import { useBoardViewport } from "@/hooks/use-board-viewport";
import {
  addFrame,
  DEFAULT_SIZE,
  useFrames,
  type Frame,
  type FrameType,
  type NewFrame,
} from "@/lib/board";
import { guestLink, saveIdentity } from "@/lib/link";
import type { Approval, Presence } from "@/lib/room";
import { useApprovals, usePeers, useRoom, useRoomState } from "@/lib/room-context";
import { readSelection } from "@/lib/selection";
import { useSnapPreview } from "@/lib/snap-preview";
import { cn } from "@/lib/utils";
import { PAGE_VERSION, versionSkew } from "@/lib/version";
import type { AgentConfigOption, AgentConfigValue, GuestAccess } from "../../shared/protocol";

export function Board() {
  const room = useRoomState();
  const frames = useFrames(room.doc);
  const { wrapRef, canvasRef, scale, ...viewport } = useBoardViewport(
    `canvas.viewport.${room.link.roomId}`,
  );
  // A host tab another tab took over reaches no one until it takes the board back.
  const readOnly = room.isHost
    ? room.serverStatus === "replaced"
    : room.roomState?.access === "view";
  const go = useBoardNavigation(room, viewport, readOnly);

  // Publish our pointer (board coordinates), text selections and frame focus as presence.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let raf = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        room.setPresence({ pointer: viewport.toBoard(event.clientX, event.clientY) }),
      );
    };
    const onLeave = () => room.setPresence({ pointer: null });
    // Pressing on the board itself lets go of the frame we were in.
    const onDown = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-frame], [data-hud]")) room.focusFrame(null);
    };
    const onSelection = () => {
      const selection = readSelection();
      const current = (room.awareness.getLocalState() as Presence | null)?.selection ?? null;
      // Line selections in a source view are not DOM selections; the view owns them.
      if (!selection && current?.kind === "lines") return;
      if (JSON.stringify(selection) !== JSON.stringify(current)) room.setPresence({ selection });
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    wrap.addEventListener("pointerdown", onDown);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("pointerdown", onDown);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [room, viewport, wrapRef]);

  const create = (type: FrameType, extra: Record<string, string> = {}) => {
    const size = DEFAULT_SIZE[type];
    const centre = viewport.centre();
    const offset = (frames.length % 5) * 24;
    const count = frames.filter((f) => f.type === type).length + 1;
    const base = {
      x: Math.round(centre.x - size.w / 2 + offset),
      y: Math.round(centre.y - size.h / 2 + offset),
      ...size,
    };
    const frame =
      type === "agent"
        ? // The frame asks which agent to run.
          { ...base, type, title: `agent-${count}`, agent: "" }
        : type === "file"
          ? // The frame opens with its tree, to pick a file.
            { ...base, type, title: `files-${count}`, path: "" }
          : type === "browser"
            ? { ...base, type, title: `preview-${count}`, url: extra.url ?? "https://example.com" }
            : { ...base, type, title: `shell-${count}` };
    addFrame(room.doc, frame as NewFrame);
  };

  return (
    <GoProvider value={go}>
      <div className="flex h-full flex-col">
        <TopBar />
        <VersionNotice />
        <div
          ref={wrapRef}
          data-board=""
          className="bg-dot-grid relative isolate min-h-0 flex-1 touch-none overflow-hidden [&[data-grabbing]]:cursor-grabbing"
        >
          <div ref={canvasRef} className="absolute top-0 left-0 origin-top-left">
            {frames.map((frame) => (
              <FrameView key={frame.id} frame={frame} readOnly={readOnly} />
            ))}
            <SnapGhost />
            <Pointers />
          </div>

          {!readOnly && <Toolbar onCreate={create} />}
          <Approvals />
          <HostElsewhere />
          {frames.length === 0 && <EmptyBoard readOnly={readOnly} />}

          <div
            data-hud=""
            className="bg-card/90 absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => viewport.zoomBy(1 / 1.25)}
              title="Zoom out"
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-14 font-mono tabular-nums"
              title="Reset to 100%"
              onClick={() => viewport.zoomTo(1)}
            >
              {Math.round(scale * 100)}%
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => viewport.zoomBy(1.25)}
              title="Zoom in"
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Fit board to view"
              onClick={() => viewport.fit(frames)}
            >
              <Maximize2 />
            </Button>
          </div>
        </div>
      </div>
    </GoProvider>
  );
}

function FrameView({ frame, readOnly }: { frame: Frame; readOnly: boolean }) {
  switch (frame.type) {
    case "agent":
      return <AgentFrame frame={frame} readOnly={readOnly} />;
    case "file":
      return <FileFrame frame={frame} readOnly={readOnly} />;
    case "browser":
      return <BrowserFrame frame={frame} readOnly={readOnly} />;
    case "terminal":
      return <TerminalFrame frame={frame} readOnly={readOnly} />;
  }
}

function Toolbar({
  onCreate,
}: {
  onCreate: (type: FrameType, extra?: Record<string, string>) => void;
}) {
  return (
    <div
      data-hud=""
      className="bg-card/90 absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur"
    >
      <Button variant="ghost" size="sm" onClick={() => onCreate("agent")}>
        <Bot /> Agent
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onCreate("file")}>
        <FileCode /> Files
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onCreate("browser")}>
        <Globe /> Browser
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onCreate("terminal")}>
        <SquareTerminal /> Terminal
      </Button>
    </div>
  );
}

function EmptyBoard({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="bg-muted/60 max-w-sm rounded-lg border border-dashed p-4 text-center">
        <h2 className="mb-1 text-[11px] font-semibold tracking-wide uppercase">Empty board</h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {readOnly
            ? "The host hasn't added anything yet."
            : "Add an agent from the toolbar. It runs on the host's machine; everyone here sees the thread and can write the prompt together."}
        </p>
      </div>
    </div>
  );
}

/**
 * Where the frame being dragged lands if dropped now: its outline, or, going
 * in between two frames or rows, a dotted line along the gap.
 */
function SnapGhost() {
  const preview = useSnapPreview();
  if (!preview) return null;
  const hint = (
    <span
      className="bg-card text-muted-foreground absolute -top-6 left-0 origin-bottom-left rounded-sm border px-1.5 py-0.5 text-[11px] whitespace-nowrap shadow-sm"
      style={{ transform: "scale(calc(1 / var(--board-scale, 1)))" }}
    >
      {preview.kind === "insert" ? "Insert here · " : ""}Alt: place freely · Shift: move the cluster
    </span>
  );
  if (preview.kind === "place") {
    const { box } = preview;
    return (
      <div
        data-snap-preview="place"
        className="border-primary/70 bg-primary/5 pointer-events-none absolute z-[99999] border-2 border-dashed"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      >
        {hint}
      </div>
    );
  }
  const { line } = preview;
  const width = "calc(4px / var(--board-scale, 1))";
  const vertical = line.w === 0;
  return (
    <div
      data-snap-preview="insert"
      className="border-primary pointer-events-none absolute z-[99999] border-0 border-dotted"
      style={{
        left: line.x,
        top: line.y,
        width: line.w,
        height: line.h,
        ...(vertical
          ? { borderLeftWidth: width, transform: "translateX(-50%)" }
          : { borderTopWidth: width, transform: "translateY(-50%)" }),
      }}
    >
      {hint}
    </div>
  );
}

/** Everyone else's mouse, in board space; the label stays a constant size. */
function Pointers() {
  const peers = usePeers();
  return (
    <>
      {peers
        .filter((peer) => peer.pointer)
        .map((peer) => (
          <div
            key={peer.user.peerId}
            className="pointer-events-none absolute top-0 left-0 z-[100000] transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${peer.pointer!.x}px, ${peer.pointer!.y}px)` }}
          >
            <div
              className="origin-top-left"
              style={{ transform: "scale(calc(1 / var(--board-scale, 1)))" }}
            >
              <MousePointer2
                className="size-5 -translate-x-0.5 -translate-y-0.5"
                style={{ color: peer.user.color, fill: peer.user.color }}
              />
              <span
                className="ml-3 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap shadow-sm"
                style={{ backgroundColor: peer.user.color, color: "oklch(0.2 0 0)" }}
              >
                {peer.user.name}
                {peer.user.host && " · host"}
              </span>
            </div>
          </div>
        ))}
    </>
  );
}

/** Host: another tab took over the board; this one waits until it is asked back. */
function HostElsewhere() {
  const room = useRoomState();
  if (room.serverStatus !== "replaced") return null;
  return (
    <div
      data-hud=""
      data-host-elsewhere=""
      data-status="blocked"
      className="bg-card border-status-blocked/45 absolute top-3 left-1/2 flex w-[28rem] -translate-x-1/2 items-center gap-3 border border-l-[3px] border-l-[var(--status)] p-3 shadow-md"
    >
      <p className="text-xs leading-relaxed">
        This board is open as host in another tab. Agents, terminals and files follow that tab.
      </p>
      <Button size="sm" onClick={() => room.takeOver()}>
        Use here
      </Button>
    </div>
  );
}

function Approvals() {
  const approvals = useApprovals();
  if (!approvals.length) return null;
  return (
    <div data-hud="" className="absolute top-3 right-3 flex w-80 flex-col gap-2">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const room = useRoom();
  const { request, peer } = approval;
  const what =
    request.t === "agent-prompt"
      ? "wants to send a prompt"
      : request.t === "agent-create"
        ? `wants to start ${request.agent}`
        : request.t === "agent-config"
          ? `wants to set ${describeConfig(room.session(request.sessionId)?.options, request)}`
          : request.t === "term-input"
            ? "wants to type in a terminal"
            : "wants to stop an agent";
  return (
    <div
      className="bg-card border-status-ready/45 border border-l-[3px] p-3 shadow-md"
      style={{ borderLeftColor: peer.color }}
      data-status="ready"
    >
      <p className="mb-1 text-xs">
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
    </div>
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

// ---------------------------------------------------------------------------

/** The page and `canvas serve` are different releases: say which to update. */
function VersionNotice() {
  const room = useRoomState();
  const [dismissed, setDismissed] = useState(false);
  const serve = room.roomState?.version;
  const skew = versionSkew(PAGE_VERSION, serve);
  if (!skew || dismissed) return null;
  const channel = PAGE_VERSION?.includes("-") ? "next" : "latest";
  const theirs = room.isHost ? "canvas serve" : "the host's canvas serve";
  return (
    <div
      data-version-notice={skew}
      data-status="ready"
      className="bg-status-ready/10 border-status-ready/45 flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-[var(--status)]" />
      {skew === "page-older" ? (
        <>
          <span>
            This page is canvas {PAGE_VERSION}, {theirs} is {serve}. Reload to get the page that
            matches it.
          </span>
          <Button size="sm" variant="outline" onClick={() => location.reload()}>
            <RotateCw /> Reload
          </Button>
        </>
      ) : room.isHost ? (
        <span>
          canvas serve is {serve}, older than this page ({PAGE_VERSION}); some things won't work.
          Restart it with{" "}
          <code className="bg-muted rounded px-1 font-mono">
            bunx @frebreco/canvas@{channel} serve
          </code>
          .
        </span>
      ) : (
        <span>
          The host's canvas serve is {serve}, older than this page ({PAGE_VERSION}); some things may
          not work until they update it.
        </span>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        title="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}

function TopBar() {
  const room = useRoomState();
  const peers = usePeers();
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(room.identity.name);

  return (
    <header className="bg-card flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <span className="font-mono text-sm font-semibold">canvas</span>
      <span
        className="text-muted-foreground truncate font-mono text-[11px]"
        title="working dir on the host"
      >
        {room.roomState?.cwd}
      </span>
      <ConnectionIndicator />

      <div className="ml-auto flex items-center gap-2">
        <div className="flex -space-x-1">
          {peers.map((peer) => (
            <span
              key={peer.user.peerId}
              title={`${peer.user.name}${peer.user.host ? " (host)" : ""}`}
              className="border-card grid size-6 place-items-center rounded-full border-2 text-[10px] font-semibold"
              style={{ backgroundColor: peer.user.color, color: "oklch(0.2 0 0)" }}
            >
              {peer.user.name.slice(0, 1)}
            </span>
          ))}
        </div>
        <input
          aria-label="Your name"
          className="bg-muted/60 w-28 rounded-md border-l-[3px] px-2 py-1 text-xs outline-none"
          style={{ borderLeftColor: room.identity.color }}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const identity = { ...room.identity, name: name.trim() || room.identity.name };
            saveIdentity(identity);
            room.rename(identity);
          }}
        />
        {room.isHost ? <AccessSelect /> : <AccessBadge access={room.roomState?.access} />}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(guestLink(room.link, undefined, room.guestRelay()));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy guest link"}
        </Button>
      </div>
    </header>
  );
}

const ACCESS: Record<GuestAccess, string> = {
  view: "Guests: view only",
  edit: "Guests: edit, I approve runs",
  trusted: "Guests: trusted",
};

function AccessSelect() {
  const room = useRoom();
  return (
    <select
      aria-label="Guest access"
      className="bg-muted/60 rounded-md px-2 py-1 text-xs outline-none"
      value={room.roomState?.access ?? "edit"}
      onChange={(event) => room.setAccess(event.target.value as GuestAccess)}
    >
      {Object.entries(ACCESS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function AccessBadge({ access }: { access: GuestAccess | undefined }) {
  if (!access) return null;
  const label = { view: "view only", edit: "can edit · runs need approval", trusted: "trusted" }[
    access
  ];
  return (
    <span className={cn("bg-secondary rounded-md px-2 py-1 font-mono text-[11px]")}>{label}</span>
  );
}
