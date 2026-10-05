import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type { Address } from "../../shared/address";
import type { SessionMeta } from "../../shared/protocol";
import { useFrames } from "../hooks/use-doc";
import type { Peer, Room } from "./room";
import { frameSessions, waitingFrames } from "./sessions";

type WaitingSession = ReturnType<Room["waitingSessions"]>[number];

export const RoomContext = createContext<Room | null>(null);

export function useRoom(): Room {
  const room = useContext(RoomContext);
  if (!room) throw new Error("useRoom outside a board");
  return room;
}

/** Re-render on room-level changes (connection, policy, host presence). */
export function useRoomState() {
  const room = useRoom();
  useSyncExternalStore(
    (onChange) => room.subscribe("room", onChange),
    () =>
      `${room.serverStatus}:${room.hostOnline}:${room.admission}:${room.access}:${room.roomState?.hostPeerId}:${room.roomState?.runtime}:${room.roomState?.version}:${room.sessionsKnown}`,
  );
  return room;
}

/** The connection log; the dialog polls the rest (`use-connection.ts`). */
export function useConnectionLog() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("connection", onChange),
    () => room.log,
  );
}

/** Host: the members `canvas serve` keeps. */
export function useMembers() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("members", onChange),
    () => room.members,
  );
}

/** Host: the fingerprints of the members trusted this session. */
export function useTrusted() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("members", onChange),
    () => room.trusted,
  );
}

/** Host: who waits in the lobby. */
export function useKnocks() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("members", onChange),
    () => room.knocks,
  );
}

export function useApprovals() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("approvals", onChange),
    () => room.approvals,
  );
}

/**
 * The same address while it names the same place (ADR 0013): what the hooks
 * below take, so a new object each render doesn't subscribe again.
 */
function useAddress(at: Address): Address {
  const { runtime, root } = at;
  return useMemo(
    () => ({ ...(runtime !== undefined && { runtime }), ...(root !== undefined && { root }) }),
    [runtime, root],
  );
}

/** A session's mirrored log, of the runtime `at` names; `version` changes with every event. */
export function useSession(id: string, address: Address = {}) {
  const room = useRoom();
  const at = useAddress(address);
  const subscribe = useCallback(
    (onChange: () => void) => room.subscribe(room.topic("session", at, id), onChange),
    [room, at, id],
  );
  const signal = useSyncExternalStore(subscribe, () => {
    const session = room.session(id, at);
    return session ? `${session.version}:${session.meta.status}` : "none";
  });
  const session = room.session(id, at);
  return useMemo(
    () =>
      session
        ? {
            meta: session.meta,
            events: session.events,
            options: session.options,
            version: session.version,
            /** Its history is still on its way from the host. */
            loading: session.pending !== null,
          }
        : null,
    // `signal` is the change signal for the mutable session record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, signal],
  );
}

/** The settings a kind of agent offers a new session; undefined until the host knows them. */
export function useKindOptions(agent: string, address: Address = {}) {
  const room = useRoom();
  const at = useAddress(address);
  return useSyncExternalStore(
    (onChange) => room.subscribe("sessions", onChange),
    () => room.kindOptions(agent, at),
  );
}

/**
 * The agent frames a session blocked on a permission for the host points at,
 * by id: those showing it, else the frame of its turn (ADR 0012, decision 3).
 */
export function useWaitingFrames(): ReadonlySet<string> {
  const room = useRoom();
  const frames = useFrames(room.doc);
  const key = useSyncExternalStore(
    (onChange) => room.subscribe("sessions", onChange),
    () => JSON.stringify(room.waitingSessions()),
  );
  return useMemo(
    () =>
      new Set(
        waitingFrames(
          // Waiting sessions are the board's own runtime's (ADR 0013): so are the frames to point at.
          frames.filter((frame) => room.reachOf(frame) === "own"),
          JSON.parse(key) as WaitingSession[],
        ),
      ),
    [room, frames, key],
  );
}

/**
 * Every session of the board on the runtime `at` names, the last active
 * first (ADR 0012): heads, without logs.
 */
export function useBoardSessions(address: Address = {}): ReadonlyArray<SessionMeta> {
  const room = useRoom();
  const at = useAddress(address);
  return useSyncExternalStore(
    (onChange) => room.subscribe("sessions", onChange),
    () => room.sessionMetas(at),
  );
}

/** The sessions that began in a frame, on its runtime, the last active first (ADR 0012, decision 2). */
export function useFrameSessions(frameId: string, at: Address = {}): ReadonlyArray<SessionMeta> {
  const all = useBoardSessions(at);
  return useMemo(() => frameSessions(all, frameId), [all, frameId]);
}

/** A file of the runtime and root `at` names, as the host mirrors it; undefined until it arrives. */
export function useFile(path: string, address: Address = {}) {
  const room = useRoom();
  const at = useAddress(address);
  const subscribe = useCallback(
    (onChange: () => void) => room.subscribe(room.topic("file", at, path), onChange),
    [room, at, path],
  );
  return useSyncExternalStore(subscribe, () => room.file(path, at));
}

/** A root's shared set's file list; null until the host sends it (never to `view` guests). */
export function useTree(address: Address = {}) {
  const room = useRoom();
  const at = useAddress(address);
  return useSyncExternalStore(
    (onChange) => room.subscribe("tree", onChange),
    () => room.tree(at),
  );
}

/** Everyone else's presence, re-read on every awareness change. */
export function usePeers(): Peer[] {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("peers", onChange),
    () => room.peerList,
  );
}

/** Who occupies a frame, and whether we follow them (see `focus.ts`). */
export function useFrameFocus(frameId: string) {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("focus", onChange),
    () => room.frameFocus(frameId),
  );
}
