import {
  Check,
  GripVertical,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { AgentFrame } from "@/components/agent-frame";
import { ConnectionIndicator } from "@/components/connection-dialog";
import { GoProvider, useGo } from "@/components/board-link";
import { BrowserFrame } from "@/components/browser-frame";
import { DrawingFrame } from "@/components/drawing-frame";
import { FileFrame } from "@/components/file-frame";
import { FRAME_KINDS, UnreachableFrame } from "@/components/frame-shell";
import { Edges } from "@/components/edges";
import { FullscreenBar } from "@/components/fullscreen";
import { Inserts } from "@/components/inserts";
import { AccessBadge, KnockCard, Lobby, MembersButton } from "@/components/members";
import { TerminalFrame } from "@/components/terminal-frame";
import { Button } from "@/components/ui/button";
import { useBoardNavigation } from "@/hooks/use-board-navigation";
import { useFollowView } from "@/hooks/use-follow-view";
import { BoardScale, useBoardViewport, type BoardViewport } from "@/hooks/use-board-viewport";
import { FullscreenProvider, useFullscreen, type Fullscreen } from "@/hooks/use-fullscreen";
import { useAnchor } from "@/hooks/use-anchor";
import { useBoardKeys } from "@/hooks/use-board-keys";
import { startDrag } from "@/hooks/start-drag";
import {
  addFrame,
  applyLayout,
  newFrame,
  own,
  useBoard,
  useFrames,
  type Frame,
  type FrameType,
} from "@/lib/board";
import { mayEdit } from "@/lib/admission";
import { preview, useDrag, type DragGhost } from "@/lib/drag";
import { guestLink, saveIdentity } from "@/lib/link";
import type { Approval, Peer, Presence } from "@/lib/room";
import {
  useApprovals,
  useKnocks,
  usePeers,
  useRoom,
  useRoomState,
  useWaitingFrames,
} from "@/lib/room-context";
import { readSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { PAGE_VERSION, versionSkew } from "@/lib/version";
import { edgeMarker, showsAny, toViewport, viewRect } from "@/lib/viewport";
import { readable } from "../../shared/identity";
import { MIN_H, MIN_W, type Beside, type Box, type ResolvedCluster } from "../../shared/layout";
import type { AgentConfigOption, AgentConfigValue } from "../../shared/protocol";

/** A guest sees the board once the host lets it in (ADR 0011); until then, the lobby. */
export function Board() {
  const room = useRoomState();
  if (!room.isHost && room.admission !== "admitted")
    return (
      <div className="flex h-full flex-col">
        <TopBar following={null} onFollow={() => {}} fullscreen={null} />
        <Lobby />
      </div>
    );
  return <BoardView />;
}

function BoardView() {
  const room = useRoomState();
  const board = useBoard(room.doc);
  const { frames } = board;
  // A drag of ours shows its drop's result: the others make room (`drag.ts`).
  const drag = useDrag();
  const shown = useMemo(
    () => (drag ? preview(board.tree, frames, drag) : { frames, landing: null }),
    [board.tree, frames, drag],
  );
  const { wrapRef, canvasRef, scale, ...viewport } = useBoardViewport(
    `canvas.viewport.${room.link.hostPublicKey}`,
  );
  // A host tab another tab took over reaches no one until it takes the board back;
  // one canvas serve refused, never.
  const readOnly = room.isHost
    ? room.serverStatus === "replaced" || room.serverStatus === "refused"
    : !mayEdit(room.access);
  const go = useBoardNavigation(room, viewport, readOnly);
  const { followed, toggle: toggleFollow } = useFollowView(viewport);
  const fullscreen = useFullscreen(room, frames, viewport);
  const { row, height, show, lead, exit, leave } = fullscreen;
  const { panBy } = viewport;
  const fullscreenFrames = useMemo(
    () => ({ row, height, show, exit, scroll: (dx: number) => panBy(-dx, 0) }),
    [row, height, show, exit, panBy],
  );
  // Following someone shows their view, or, in full screen, full screen on their frame.
  const following = followed !== null;
  const led = followed?.fullscreen ?? null;
  useEffect(() => {
    if (led) lead(led);
    else if (following) leave();
  }, [following, led, lead, leave]);
  // Where we are in full screen, for everyone: followers go there too.
  const current = fullscreen.current;
  useEffect(() => room.setPresence({ fullscreen: current }), [room, current]);
  // The frame we are on stays put on our screen as others change the layout.
  useAnchor(
    room.doc,
    frames,
    () => (row ? current : room.ownFrame()),
    viewport,
    following || drag !== null,
  );

  // Publish our pointer (board coordinates), text selections and frame focus as presence.
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let raf = 0;
    const publishPointer = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const at = pointerAt.current;
        if (at) room.setPresence({ pointer: viewport.toBoard(at.x, at.y) });
      });
    };
    const onMove = (event: PointerEvent) => {
      pointerAt.current = { x: event.clientX, y: event.clientY };
      publishPointer();
    };
    const onLeave = () => {
      pointerAt.current = null;
      cancelAnimationFrame(raf);
      room.setPresence({ pointer: null });
    };
    // Panning and zooming move the board under a mouse that stays put.
    const unsubscribe = viewport.subscribe(() => {
      if (pointerAt.current) publishPointer();
    });
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
      unsubscribe();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("pointerdown", onDown);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [room, viewport, wrapRef]);

  // Publish what we look at, throttled: it changes on every frame of a pan, and
  // peers smooth between updates.
  const { screen, subscribe } = viewport;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const publish = () => {
      timer = null;
      last = Date.now();
      const { transform, width, height } = screen();
      room.setPresence({ view: width && height ? viewRect(transform, width, height) : null });
    };
    const unsubscribe = subscribe(() => {
      timer ??= setTimeout(publish, Math.max(0, VIEW_INTERVAL - (Date.now() - last)));
    });
    publish();
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [room, screen, subscribe]);

  // Our drag, as a ghost for everyone else.
  const ghost = useMemo((): DragGhost | null => {
    if (!drag) return null;
    const moving = shown.frames.filter((f) =>
      drag.kind === "frame" ? f.id === drag.frame : f.cluster === drag.cluster,
    );
    if (!moving.length) return null;
    const x = Math.min(...moving.map((f) => f.x));
    const y = Math.min(...moving.map((f) => f.y));
    const box = {
      x,
      y,
      w: Math.max(...moving.map((f) => f.x + f.w)) - x,
      h: Math.max(...moving.map((f) => f.y + f.h)) - y,
    };
    const name = board.layout.clusters.find((k) => k.id === moving[0]!.cluster)?.name;
    const title = drag.kind === "frame" ? moving[0]!.title : name || "cluster";
    return { title, box, landing: shown.landing };
  }, [drag, shown, board.layout]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => room.setPresence({ drag: ghost }));
    return () => cancelAnimationFrame(raf);
  }, [room, ghost]);

  // Beside the frame we are in; else a cluster of its own. Then we go there.
  const create = (type: FrameType, extra: Record<string, string> = {}) => {
    const mine = room.ownFrame();
    const target = frames.some((f) => f.id === mine)
      ? { anchor: mine!, side: "right" as const }
      : { before: null };
    const id = own(room.doc, () => addFrame(room.doc, newFrame(type, frames, extra), target));
    go({ kind: "board", target: { frame: id } });
  };
  useBoardKeys({ room, board, fullscreen, viewport, readOnly, create });

  // "+" on the edges of rows: in full screen, its row's, as tall as they show.
  const insertable = useMemo(
    () =>
      row
        ? row.frames.map((f) => ({
            ...f,
            y: row.top,
            h: f.type === "terminal" ? (f.height ?? f.h) : height,
          }))
        : shown.frames,
    [row, height, shown.frames],
  );
  const insert = (type: FrameType, target: Beside) => {
    const id = own(room.doc, () => addFrame(room.doc, newFrame(type, frames), target));
    if (row) show(id);
    else go({ kind: "board", target: { frame: id } });
  };

  return (
    <GoProvider value={go}>
      <div className="flex h-full flex-col">
        <TopBar
          following={followed?.user.peerId ?? null}
          onFollow={toggleFollow}
          fullscreen={fullscreen}
        />
        <VersionNotice />
        <div
          ref={wrapRef}
          data-board=""
          className="bg-dot-grid relative isolate min-h-0 flex-1 touch-none overflow-hidden [&[data-grabbing]]:cursor-grabbing [&[data-grabbing]_*]:cursor-grabbing! [&[data-pan-ready]]:cursor-grab [&[data-pan-ready]:not([data-grabbing])_*]:cursor-grab!"
        >
          <div ref={canvasRef} className="absolute top-0 left-0 origin-top-left">
            <BoardScale value={scale}>
              <FullscreenProvider value={fullscreenFrames}>
                {shown.frames.map((frame) => (
                  <FrameView key={frame.id} frame={frame} readOnly={readOnly} />
                ))}
              </FullscreenProvider>
            </BoardScale>
            {!row && !drag && <ClusterGrips clusters={board.layout.clusters} readOnly={readOnly} />}
            {!readOnly && !drag && (
              <Edges layout={board.layout} fullscreen={row ? { row, height } : null} />
            )}
            {!readOnly && !drag && (
              <Inserts frames={insertable} wrapRef={wrapRef} viewport={viewport} onAdd={insert} />
            )}
            <Landing box={shown.landing} along={drag?.kind === "frame" && drag.along} />
            <DragGhosts />
            <Pointers />
          </div>

          {followed && (
            <>
              <div
                data-following-view={followed.user.name}
                className="pointer-events-none absolute inset-0 border-[3px]"
                style={{ borderColor: followed.user.color }}
              />
              <div
                data-hud=""
                className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full py-1 pr-1 pl-3 text-xs font-semibold shadow-sm"
                style={{ backgroundColor: followed.user.color, color: "oklch(0.2 0 0)" }}
              >
                Following {followed.user.name}
                <button
                  type="button"
                  className="rounded-full bg-black/15 px-2 py-0.5 hover:bg-black/25"
                  onClick={() => toggleFollow(null)}
                >
                  Stop
                </button>
              </div>
            </>
          )}
          <PeerMarkers viewport={viewport} />
          <WaitingMarkers frames={frames} viewport={viewport} />
          {!readOnly && !row && <Toolbar onCreate={create} />}
          <Approvals />
          <HostElsewhere />
          <HostRefused />
          {frames.length === 0 && <EmptyBoard readOnly={readOnly} />}

          <div
            data-hud=""
            className={cn(
              "bg-card/90 absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur",
              // Full screen's frames reach the bottom; zooming would end it anyway.
              row && "hidden",
            )}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => viewport.zoomStep(-1)}
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
              onClick={() => viewport.zoomStep(1)}
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
  const room = useRoomState();
  const reach = room.reachOf(frame);
  if (reach !== "own") return <UnreachableFrame frame={frame} readOnly={readOnly} reach={reach} />;
  switch (frame.type) {
    case "agent":
      return <AgentFrame frame={frame} readOnly={readOnly} />;
    case "file":
      return <FileFrame frame={frame} readOnly={readOnly} />;
    case "browser":
      return <BrowserFrame frame={frame} readOnly={readOnly} />;
    case "terminal":
      return <TerminalFrame frame={frame} readOnly={readOnly} />;
    case "drawing":
      return <DrawingFrame frame={frame} readOnly={readOnly} />;
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
      {FRAME_KINDS.map(({ type, label, Icon }, i) => (
        <Button
          key={type}
          variant="ghost"
          size="sm"
          title={`${label}, beside the frame you are in (${i + 1})`}
          onClick={() => onCreate(type)}
        >
          <Icon /> {label}
        </Button>
      ))}
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
 * Where our drag lands if dropped now: its place, the others making room
 * around it; or, a new cluster, a bar in its gap, above the dragged frame
 * and as thick at any zoom.
 */
function Landing({ box, along }: { box: Box | null; along: boolean }) {
  if (!box || along) return null;
  const thick = "calc(4px / var(--board-scale, 1))";
  if (box.w < MIN_W || box.h < MIN_H)
    return (
      <div
        data-drop-landing=""
        className="bg-primary pointer-events-none absolute z-[99999] rounded-full"
        style={
          box.w < MIN_W
            ? {
                left: box.x + box.w / 2,
                top: box.y,
                width: thick,
                height: box.h,
                translate: "-50% 0",
              }
            : {
                left: box.x,
                top: box.y + box.h / 2,
                width: box.w,
                height: thick,
                translate: "0 -50%",
              }
        }
      />
    );
  return (
    <div
      data-drop-landing=""
      className="border-primary/70 bg-primary/5 pointer-events-none absolute z-[99980] border-2 border-dashed"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    />
  );
}

/**
 * Above each cluster, its grip: its name, which anyone may edit, and a handle
 * to move it to another place among the clusters (as Shift-dragging a frame
 * does). The label keeps its size at any zoom.
 */
function ClusterGrips({
  clusters,
  readOnly,
}: {
  clusters: ReadonlyArray<ResolvedCluster>;
  readOnly: boolean;
}) {
  const room = useRoom();
  return (
    <>
      {clusters.map((cluster) => {
        const { box } = cluster;
        if (readOnly && !cluster.name) return null;
        return (
          <div
            key={cluster.id}
            data-hud=""
            data-cluster-grip={cluster.id}
            className="absolute flex origin-bottom-left items-center gap-0.5 pb-1.5 select-none"
            style={{
              left: box.x,
              top: box.y,
              transform: "translateY(-100%) scale(calc(1 / var(--board-scale, 1)))",
            }}
          >
            {!readOnly && (
              <button
                type="button"
                title="Move the cluster"
                className="text-muted-foreground hover:text-foreground cursor-grab rounded-sm p-0.5 active:cursor-grabbing"
                onPointerDown={(event) =>
                  startDrag(event, {
                    doc: room.doc,
                    what: { kind: "cluster", id: cluster.id },
                    origin: box,
                  })
                }
              >
                <GripVertical className="size-3.5" />
              </button>
            )}
            <input
              aria-label="Cluster name"
              placeholder="cluster"
              readOnly={readOnly}
              value={cluster.name ?? ""}
              size={Math.max(7, (cluster.name ?? "").length + 1)}
              className="text-muted-foreground focus:text-foreground placeholder:text-muted-foreground/50 bg-transparent font-mono text-[11px] font-medium outline-none"
              onChange={(event) =>
                applyLayout(room.doc, [
                  { kind: "container", id: cluster.id, set: { name: event.target.value } },
                ])
              }
            />
          </div>
        );
      })}
    </>
  );
}

/** Everyone else's drag, in their colour: the frame where their pointer has it, and where it lands. */
function DragGhosts() {
  const peers = usePeers();
  return (
    <>
      {peers.map(({ user, drag }) =>
        drag ? (
          <div key={user.peerId} data-drag-ghost={user.name} className="pointer-events-none">
            {drag.landing && (
              <div
                className="absolute z-[99970] border-2 border-dashed"
                style={{
                  left: drag.landing.x,
                  top: drag.landing.y,
                  width: drag.landing.w,
                  height: drag.landing.h,
                  borderColor: user.color,
                }}
              />
            )}
            <div
              className="absolute z-[99975] border-2 transition-[left,top] duration-75 ease-linear"
              style={{
                left: drag.box.x,
                top: drag.box.y,
                width: drag.box.w,
                height: drag.box.h,
                borderColor: user.color,
                backgroundColor: `color-mix(in oklab, ${user.color} 12%, transparent)`,
              }}
            >
              <span
                className="absolute top-0 left-0 origin-top-left px-1.5 py-0.5 font-mono text-[11px] font-semibold whitespace-nowrap"
                style={{
                  backgroundColor: user.color,
                  color: "oklch(0.2 0 0)",
                  transform: "scale(calc(1 / var(--board-scale, 1)))",
                }}
              >
                {user.name} · {drag.title}
              </span>
            </div>
          </div>
        ) : null,
      )}
    </>
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
                {peer.fingerprint && (
                  <span className="ml-1.5 font-mono font-normal opacity-70">
                    {readable(peer.fingerprint)}
                  </span>
                )}
              </span>
            </div>
          </div>
        ))}
    </>
  );
}

/** How often our view goes out as presence, in ms; peers' markers ease over as long. */
const VIEW_INTERVAL = 100;
/** Markers keep clear of the toolbar at the top and the zoom controls at the bottom. */
const MARKER_INSET = { top: 64, right: 20, bottom: 60, left: 20 };

/**
 * Everyone out of view, as a marker on the edge in their direction: where
 * their mouse is, or, while it is off their board, the middle of their view.
 * A click goes there.
 */
function PeerMarkers({
  viewport,
}: {
  viewport: Pick<BoardViewport, "screen" | "subscribe" | "centreOn">;
}) {
  const peers = usePeers();
  const { transform, width, height } = useSyncExternalStore(viewport.subscribe, viewport.screen);
  if (!width || !height) return null;
  return (
    <>
      {peers.map((peer) => {
        const { view } = peer;
        const target = peer.pointer ?? (view && { x: view.x + view.w / 2, y: view.y + view.h / 2 });
        const marker =
          target && edgeMarker(toViewport(transform, target), width, height, MARKER_INSET);
        if (!target || !marker) return null;
        return (
          <button
            key={peer.user.peerId}
            type="button"
            data-hud=""
            data-peer-marker={peer.user.name}
            title={`${who(peer)}: go there`}
            onClick={() => viewport.centreOn(target)}
            className="border-card absolute top-0 left-0 grid size-7 place-items-center rounded-full border-2 text-[11px] font-semibold shadow-md transition-transform duration-100 ease-linear"
            style={{
              transform: `translate(${marker.x}px, ${marker.y}px) translate(-50%, -50%)`,
              backgroundColor: peer.user.color,
              color: "oklch(0.2 0 0)",
            }}
          >
            <span
              className="pointer-events-none absolute inset-0"
              style={{ transform: `rotate(${marker.angle}rad)` }}
            >
              <span
                className="absolute -top-[9px] left-1/2 -translate-x-1/2 border-x-[6px] border-b-[8px] border-x-transparent"
                style={{ borderBottomColor: peer.user.color }}
              />
            </span>
            {peer.user.name.slice(0, 1)}
          </button>
        );
      })}
    </>
  );
}

/** Agent frames waiting for the host, when the host is there to answer. */
function useWaiting(frames?: ReadonlyArray<Frame>) {
  const room = useRoomState();
  const waiting = useWaitingFrames();
  const all = useFrames(room.doc);
  if (!room.hostOnline) return [];
  return (frames ?? all).filter((frame) => waiting.has(frame.id));
}

/**
 * Agent frames out of view that wait on a permission, as markers on the edge
 * in their direction (like people's). A click goes there.
 */
function WaitingMarkers({
  frames,
  viewport,
}: {
  frames: ReadonlyArray<Frame>;
  viewport: Pick<BoardViewport, "screen" | "subscribe">;
}) {
  const room = useRoom();
  const go = useGo();
  const waiting = useWaiting(frames);
  const { transform, width, height } = useSyncExternalStore(viewport.subscribe, viewport.screen);
  if (!width || !height) return null;
  return (
    <>
      {waiting.map((frame) => {
        if (showsAny(transform, frame, width, height)) return null;
        const centre = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
        const marker = edgeMarker(toViewport(transform, centre), width, height, MARKER_INSET);
        if (!marker) return null;
        return (
          <button
            key={frame.id}
            type="button"
            data-hud=""
            data-waiting-marker={frame.id}
            title={`${frame.title} ${room.isHost ? "needs you" : "waits for the host"}: go there`}
            onClick={() => go({ kind: "board", target: { frame: frame.id } })}
            className="bg-status-ready border-card absolute top-0 left-0 grid size-7 place-items-center rounded-full border-2 shadow-md"
            style={{
              transform: `translate(${marker.x}px, ${marker.y}px) translate(-50%, -50%)`,
              color: "oklch(0.2 0 0)",
            }}
          >
            <span
              className="pointer-events-none absolute inset-0"
              style={{ transform: `rotate(${marker.angle}rad)` }}
            >
              <span className="border-b-status-ready absolute -top-[9px] left-1/2 -translate-x-1/2 border-x-[6px] border-b-[8px] border-x-transparent" />
            </span>
            <ShieldAlert className="size-3.5 animate-pulse" />
          </button>
        );
      })}
    </>
  );
}

/** How many agents wait on a permission; a click goes to the next one. */
function WaitingCount() {
  const room = useRoomState();
  const go = useGo();
  const waiting = useWaiting();
  const next = useRef(0);
  if (!waiting.length) return null;
  return (
    <button
      type="button"
      data-waiting-count={waiting.length}
      title={waiting.length > 1 ? "Go to the next one" : "Go there"}
      className="bg-status-ready/15 text-status-ready border-status-ready/45 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium"
      onClick={() => {
        const frame = waiting[next.current++ % waiting.length]!;
        go({ kind: "board", target: { frame: frame.id } });
      }}
    >
      <ShieldAlert className="size-3.5" />
      {waiting.length === 1
        ? `1 agent ${room.isHost ? "needs you" : "waits for the host"}`
        : `${waiting.length} agents ${room.isHost ? "need you" : "wait for the host"}`}
    </button>
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

/** Host link, but `canvas serve` doesn't know this browser (ADR 0011): say how to pair. */
function HostRefused() {
  const room = useRoomState();
  if (room.serverStatus !== "refused") return null;
  return (
    <div
      data-hud=""
      data-host-refused=""
      data-status="blocked"
      className="bg-card border-status-blocked/45 absolute top-3 left-1/2 w-[28rem] -translate-x-1/2 border border-l-[3px] border-l-[var(--status)] p-3 shadow-md"
    >
      <p className="text-xs leading-relaxed">
        canvas serve refused this browser: {room.serverRefusal}. A host link opens the board as host
        only in browsers paired with it.
      </p>
    </div>
  );
}

/** Host: who knocks (ADR 0011), and what guests ask to run. */
function Approvals() {
  const approvals = useApprovals();
  const knocks = useKnocks();
  if (!approvals.length && !knocks.length) return null;
  return (
    <div data-hud="" className="absolute top-3 right-3 flex w-80 flex-col gap-2">
      {knocks.map((knock) => (
        <KnockCard key={knock.peerId} knock={knock} />
      ))}
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
      : request.t === "agent-config"
        ? `wants to set ${describeConfig(room.optionsFor(request.sessionId), request)}`
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

function TopBar({
  following,
  onFollow,
  fullscreen,
}: {
  /** Whose view we follow. */
  following: string | null;
  onFollow: (peerId: string) => void;
  /** None in the lobby. */
  fullscreen: Fullscreen | null;
}) {
  const room = useRoomState();
  const all = usePeers();
  const inside = room.isHost || room.admission === "admitted";
  const peers = inside ? all : [];
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(room.identity.name);

  return (
    <header className="bg-card relative flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <span className="font-mono text-sm font-semibold">canvas</span>
      <span
        className="text-muted-foreground truncate font-mono text-[11px]"
        title="working dir on the host"
      >
        {room.roomState?.cwd}
      </span>
      <ConnectionIndicator />
      {fullscreen && <FullscreenBar fullscreen={fullscreen} />}
      <WaitingCount />

      <div className="ml-auto flex items-center gap-2">
        <div className="flex -space-x-1">
          {peers.map((peer) => {
            const on = peer.user.peerId === following;
            return (
              <button
                key={peer.user.peerId}
                type="button"
                aria-pressed={on}
                data-avatar={peer.user.name}
                data-fingerprint={peer.fingerprint ?? ""}
                title={`${on ? "Stop following" : "Follow"} ${who(peer)}`}
                onClick={() => onFollow(peer.user.peerId)}
                className="border-card grid size-6 place-items-center rounded-full border-2 text-[10px] font-semibold"
                style={{
                  backgroundColor: peer.user.color,
                  color: "oklch(0.2 0 0)",
                  outline: on ? `2px solid ${peer.user.color}` : undefined,
                  outlineOffset: 1,
                }}
              >
                {peer.user.name.slice(0, 1)}
              </button>
            );
          })}
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
        <span
          data-fingerprint-self={room.fingerprint}
          className="text-muted-foreground font-mono text-[11px]"
          title="This browser's fingerprint: who you are to the others on the board"
        >
          {readable(room.fingerprint)}
        </span>
        {room.isHost ? <MembersButton /> : <AccessBadge access={room.access} />}
        {inside && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(
                guestLink(room.inviteRoom(), undefined, room.guestRelay()),
              );
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy guest link"}
          </Button>
        )}
      </div>
    </header>
  );
}

/** Someone as a title names them: name, fingerprint if verified, host. */
function who(peer: Peer) {
  const fingerprint = peer.fingerprint ? readable(peer.fingerprint) : "not verified";
  return `${peer.user.name} · ${fingerprint}${peer.user.host ? " (host)" : ""}`;
}
