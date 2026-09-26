import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

import type { Presence, Room } from "./room";

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
      `${room.serverStatus}:${room.hostOnline}:${room.roomState?.access}:${room.roomState?.hostPeerId}:${room.error}`,
  );
  return room;
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
          }
        : null,
    // `signal` is the change signal for the mutable session record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, signal],
  );
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
export function usePeers(): Presence[] {
  const room = useRoom();
  return useSyncExternalStore(
    (onChange) => room.subscribe("peers", onChange),
    () => room.peerList,
  );
}
