import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

import type { Peer, Room } from "./room";

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
      `${room.serverStatus}:${room.hostOnline}:${room.admission}:${room.access}:${room.roomState?.hostPeerId}:${room.roomState?.version}:${room.sessionsKnown}`,
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

/** A session's mirrored log; `version` changes with every event. */
export function useSession(id: string) {
  const room = useRoom();
  const signal = useSyncExternalStore(
    (onChange) => room.subscribe(`session:${id}`, onChange),
    () => {
      const session = room.session(id);
      return session ? `${session.version}:${session.meta.status}` : "none";
    },
  );
  const session = room.session(id);
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
export function useKindOptions(agent: string) {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("sessions", onChange),
    () => room.kindOptions(agent),
  );
}

/** The agent frames blocked on a permission for the host, by id. */
export function useWaitingAgents(): ReadonlySet<string> {
  const room = useRoom();
  const key = useSyncExternalStore(
    (onChange) => room.subscribe("sessions", onChange),
    () => room.waitingSessions().join(" "),
  );
  return useMemo(() => new Set(key ? key.split(" ") : []), [key]);
}

/** A file as the host mirrors it; undefined until it arrives. */
export function useFile(path: string) {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe(`file:${path}`, onChange),
    () => room.file(path),
  );
}

/** The shared set's file list; null until the host sends it (never to `view` guests). */
export function useTree() {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("tree", onChange),
    () => room.tree(),
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
