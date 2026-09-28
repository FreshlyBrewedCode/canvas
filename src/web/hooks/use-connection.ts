import { useEffect, useState } from "react";

import {
  routeOf,
  type CandidateType,
  type ConnectionSnapshot,
  type PeerInfo,
  type ProbeResult,
} from "@/lib/connection";
import type { Room } from "@/lib/room";
import { useConnectionLog, useRoom } from "@/lib/room-context";

export interface ConnectionView extends ConnectionSnapshot {
  /** The full stats of each peer connection, for the details. */
  readonly stats: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

/**
 * The connection as of now, re-read every second: relays and peers always,
 * the peers' WebRTC stats only when `detailed` (the dialog is open).
 */
export function useConnection(detailed: boolean): ConnectionView {
  const room = useRoom();
  const log = useConnectionLog();
  const [view, setView] = useState<Omit<ConnectionView, "log"> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const next = await snapshot(room, detailed);
      if (!cancelled) setView(next);
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [room, detailed]);

  return { ...(view ?? baseline(room)), log };
}

function baseline(room: Room): Omit<ConnectionView, "log"> {
  return {
    now: Date.now(),
    isHost: room.isHost,
    serveStatus: room.serverStatus,
    joinedAt: room.joinedAt,
    relays: room.relays(),
    peers: [],
    hostOnline: room.hostOnline,
    stats: {},
  };
}

async function snapshot(room: Room, detailed: boolean): Promise<Omit<ConnectionView, "log">> {
  const names = new Map(room.peerList.map((p) => [p.user.peerId, p.user]));
  const stats: Record<string, Record<string, unknown>[]> = {};
  const peers = await Promise.all(
    Object.entries(room.peerConnections()).map(async ([peerId, pc]): Promise<PeerInfo> => {
      const report = detailed ? await pc.getStats().catch(() => null) : null;
      const entries = report ? ([...report.values()] as Record<string, unknown>[]) : [];
      stats[peerId] = entries;
      const user = names.get(peerId);
      return {
        peerId,
        ...(user && { name: user.name }),
        host: peerId === room.roomState?.hostPeerId,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        route: report ? routeOf(report as never) : null,
      };
    }),
  );
  return { ...baseline(room), peers, stats };
}

/**
 * trystero's default STUN servers (`@trystero-p2p/core`'s `peer.mjs`, not
 * exported): what a peer connection here would try.
 */
const STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/**
 * Gather ICE candidates as a peer connection would. A server-reflexive one
 * means UDP reaches a STUN server on the internet; only host ones mean it
 * doesn't.
 */
export async function probeNetwork(timeoutMs = 6000): Promise<ProbeResult> {
  const started = performance.now();
  const candidates: Record<CandidateType, number> = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  let pc: RTCPeerConnection;
  try {
    pc = new RTCPeerConnection({ iceServers: STUN.map((urls) => ({ urls })) });
  } catch (error) {
    return { candidates, durationMs: 0, error: String(error) };
  }
  try {
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return resolve();
        const type = candidate.type as CandidateType | null;
        if (type && type in candidates) candidates[type]++;
      };
      setTimeout(resolve, timeoutMs);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    return { candidates, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      candidates,
      durationMs: Math.round(performance.now() - started),
      error: String(error),
    };
  } finally {
    pc.close();
  }
}
