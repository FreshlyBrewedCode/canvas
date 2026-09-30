import { useCallback, useEffect, useState } from "react";

import type { BoardViewport } from "@/hooks/use-board-viewport";
import type { Presence } from "@/lib/room";
import { usePeers } from "@/lib/room-context";

/**
 * Following someone's view, as in Miro: our viewport shows theirs until we
 * pan or zoom ourselves, they leave, or we let go. Someone in full screen we
 * follow into it, on their frame, at our own screen's size. Not frame focus
 * (`focus.ts`): that follows an occupant's scroll inside one frame.
 */
export function useFollowView(viewport: Pick<BoardViewport, "follow" | "onOwnMove">): {
  /** Whom we follow. */
  followed: Presence | null;
  /** Follow someone, or let go (null, or whom we follow already). */
  toggle: (peerId: string | null) => void;
} {
  const peers = usePeers();
  const [peerId, setPeerId] = useState<string | null>(null);
  // Once they leave, nobody (peer ids are per page load: they don't come back).
  const followed = (peerId && peers.find((peer) => peer.user.peerId === peerId)) || null;
  const following = followed !== null;
  const { follow, onOwnMove } = viewport;

  // Our own pan or zoom lets go.
  useEffect(
    () => (following ? onOwnMove(() => setPeerId(null)) : undefined),
    [following, onOwnMove],
  );

  // Their presence changes with every pointer move: go by the view's numbers.
  // In full screen, it is their frame we show, full screen (`use-fullscreen.ts`).
  const { x, y, w, h } = followed?.view ?? {};
  const fullscreen = followed?.fullscreen ?? null;
  useEffect(() => {
    if (!fullscreen && x !== undefined && y !== undefined && w && h) follow({ x, y, w, h });
  }, [x, y, w, h, fullscreen, follow]);

  const toggle = useCallback(
    (next: string | null) => setPeerId((current) => (next === current ? null : next)),
    [],
  );
  return { followed, toggle };
}
