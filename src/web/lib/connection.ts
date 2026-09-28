/**
 * What the connection dialog shows: how this browser reaches `canvas serve`
 * (host only), the signalling relays and the other peers, and what that says
 * about where a connection fails (finding 15).
 *
 * Joining takes two legs that fail differently. Signalling — finding the other
 * peers and swapping encrypted offers — runs over public Nostr relays (`wss://`);
 * a network that blocks those shows nobody at all. The peer connections are
 * WebRTC (UDP, or TURN if configured); a network that blocks those lets peers
 * find each other and then fail, which trystero reports as a join error.
 *
 * Everything here is pure, over a snapshot `useConnection` takes; reading
 * WebRTC stats and probing the network happen in the browser.
 */

import type { LinkStatus } from "./server-link";

export type Tone = "complete" | "ready" | "pending" | "blocked";

export interface ConnectionEvent {
  /** `Date.now()` */
  readonly at: number;
  readonly level: "info" | "warn" | "error";
  readonly source: "serve" | "relay" | "peer" | "host";
  readonly text: string;
  /** The peer it is about, for join errors. */
  readonly peerId?: string;
}

/** What a trystero join error says went wrong. */
export type JoinFailure = "password" | "ice" | "handshake" | "other";

export function classifyJoinError(error: string): JoinFailure {
  if (/incorrect room password/i.test(error)) return "password";
  if (/after exchanging SDP/i.test(error)) return "ice";
  if (/handshake/i.test(error)) return "handshake";
  return "other";
}

export type RelayState = "connecting" | "open" | "closing" | "closed";

export interface RelayInfo {
  readonly url: string;
  readonly state: RelayState;
}

const READY_STATES: ReadonlyArray<RelayState> = ["connecting", "open", "closing", "closed"];

export function relayState(readyState: number): RelayState {
  return READY_STATES[readyState] ?? "closed";
}

// ---------------------------------------------------------------------------
// the route a peer connection took, from its WebRTC stats

/** host: on the machine's own network; srflx/prflx: through NAT; relay: through TURN. */
export type CandidateType = "host" | "srflx" | "prflx" | "relay";

export interface Candidate {
  readonly type: CandidateType;
  /** Transport to the other side (or to the TURN server): udp or tcp. */
  readonly protocol: string;
  /** To the TURN server, for a relay candidate: udp, tcp or tls. */
  readonly relayProtocol?: string;
  readonly address?: string;
  readonly port?: number;
}

export interface Route {
  readonly local: Candidate;
  readonly remote: Candidate;
  /** Milliseconds. */
  readonly rtt?: number;
  readonly bytesSent?: number;
  readonly bytesReceived?: number;
}

export interface PeerInfo {
  readonly peerId: string;
  readonly name?: string;
  readonly host: boolean;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly route: Route | null;
  /** Reached through the relay transport, not WebRTC (ADR 0008). */
  readonly relayed?: boolean;
}

type Stat = Record<string, unknown> & { id: string; type: string };

/** The selected candidate pair of a peer connection's stats, or null before ICE settles. */
export function routeOf(stats: ReadonlyMap<string, Stat>): Route | null {
  const all = [...stats.values()];
  const transport = all.find((s) => s.type === "transport" && s.selectedCandidatePairId);
  const pair =
    (transport && stats.get(transport.selectedCandidatePairId as string)) ??
    all.find(
      (s) =>
        s.type === "candidate-pair" &&
        (s.selected === true || (s.nominated && s.state === "succeeded")),
    );
  if (!pair) return null;
  const local = candidate(stats.get(pair.localCandidateId as string));
  const remote = candidate(stats.get(pair.remoteCandidateId as string));
  if (!local || !remote) return null;
  const rtt = pair.currentRoundTripTime;
  return {
    local,
    remote,
    ...(typeof rtt === "number" && { rtt: Math.round(rtt * 1000) }),
    ...(typeof pair.bytesSent === "number" && { bytesSent: pair.bytesSent }),
    ...(typeof pair.bytesReceived === "number" && { bytesReceived: pair.bytesReceived }),
  };
}

function candidate(stat: Stat | undefined): Candidate | null {
  if (!stat) return null;
  const type = stat.candidateType as CandidateType | undefined;
  if (!type) return null;
  return {
    type,
    protocol: String(stat.protocol ?? "?"),
    ...(typeof stat.relayProtocol === "string" && { relayProtocol: stat.relayProtocol }),
    ...(typeof (stat.address ?? stat.ip) === "string" && {
      address: (stat.address ?? stat.ip) as string,
    }),
    ...(typeof stat.port === "number" && { port: stat.port }),
  };
}

/** "direct (UDP)", "through NAT (UDP)", "relayed via TURN (TLS)". */
export function describeRoute(route: Route): string {
  const relayed = [route.local, route.remote].find((c) => c.type === "relay");
  if (relayed)
    return `relayed via TURN (${(relayed.relayProtocol ?? relayed.protocol).toUpperCase()})`;
  const protocol = route.local.protocol.toUpperCase();
  if (route.local.type === "host" && route.remote.type === "host")
    return `direct, same network (${protocol})`;
  return `direct through NAT (${protocol})`;
}

// ---------------------------------------------------------------------------
// the network probe

/** What gathering ICE candidates against public STUN servers found. */
export interface ProbeResult {
  readonly candidates: Readonly<Record<CandidateType, number>>;
  readonly durationMs: number;
  readonly error?: string;
}

/** Whether this network lets WebRTC out, from the candidates it gathered. */
export function readProbe(probe: ProbeResult): { tone: Tone; text: string } {
  if (probe.error) return { tone: "blocked", text: `WebRTC unavailable: ${probe.error}` };
  const { host, srflx, relay } = probe.candidates;
  if (srflx > 0 || relay > 0)
    return { tone: "complete", text: "UDP reaches the internet: direct connections can work" };
  if (host > 0)
    return {
      tone: "blocked",
      text: "Only local addresses: UDP to the internet (STUN) seems blocked, so peers on other networks need a TURN relay",
    };
  return { tone: "blocked", text: "No candidates at all: WebRTC seems disabled or fully blocked" };
}

// ---------------------------------------------------------------------------
// the headline

export interface ConnectionSnapshot {
  readonly now: number;
  readonly isHost: boolean;
  /** How peers reach each other; null before joining. */
  readonly transport: "p2p" | "relay-signal" | "relay" | null;
  /** Host only. */
  readonly serveStatus: LinkStatus | null;
  /** When we joined the room; null before (the host joins once `canvas serve` answers). */
  readonly joinedAt: number | null;
  readonly relays: ReadonlyArray<RelayInfo>;
  readonly peers: ReadonlyArray<PeerInfo>;
  /** Guest: the host's hello verified. */
  readonly hostOnline: boolean;
  readonly log: ReadonlyArray<ConnectionEvent>;
}

export interface Headline {
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
}

/** How long relays may take before none open means they are unreachable. */
export const RELAY_GRACE_MS = 8_000;

/** Join errors about peers we are not connected to now, newest per peer. */
export function openFailures(snapshot: ConnectionSnapshot): ConnectionEvent[] {
  const connected = new Set(snapshot.peers.map((p) => p.peerId));
  const latest = new Map<string, ConnectionEvent>();
  for (const event of snapshot.log)
    if (event.source === "peer" && event.level === "error" && event.peerId)
      latest.set(event.peerId, event);
  return [...latest.values()].filter((e) => !connected.has(e.peerId!));
}

/** The one-line verdict at the top of the dialog; the first thing that's wrong wins. */
export function diagnose(snapshot: ConnectionSnapshot): Headline {
  const { isHost, serveStatus, joinedAt, relays, peers, hostOnline, now } = snapshot;

  if (isHost && serveStatus === "replaced")
    return {
      tone: "ready",
      title: "The board is open as host in another tab",
      detail: "Press Use here to make this tab the host again.",
    };
  if (isHost && serveStatus !== "open")
    return {
      tone: "blocked",
      title: "Can't reach canvas serve",
      detail:
        "This browser talks to canvas serve on your machine and retries on its own. Is it still running, and on the port the link names?",
    };
  if (joinedAt === null) return { tone: "pending", title: "Joining the room…", detail: "" };

  const openRelays = relays.filter((r) => r.state === "open").length;
  if (snapshot.transport === "relay" && openRelays === 0)
    return now - joinedAt < RELAY_GRACE_MS
      ? { tone: "pending", title: "Connecting to the relay…", detail: "" }
      : {
          tone: "blocked",
          title: "Can't reach the relay",
          detail:
            "This board goes through a canvas relay, and it doesn't answer, or refused this link's token (see the errors below). Is it running, and is the link less than 30 days old?",
        };
  if (openRelays === 0 && peers.length === 0) {
    if (now - joinedAt < RELAY_GRACE_MS)
      return {
        tone: "pending",
        title: "Connecting to signalling relays…",
        detail: "Peers find each other through public Nostr relays.",
      };
    return {
      tone: "blocked",
      title: "No signalling relay reachable",
      detail:
        snapshot.transport === "relay-signal"
          ? "Peers find each other through this board's canvas relay, and it doesn't answer, or refused this link's token."
          : "Peers find each other through public Nostr relays over wss://, and none of them answers. A proxy or firewall on this network probably blocks them.",
    };
  }

  const failures = openFailures(snapshot);
  const kinds = new Set(failures.map((f) => classifyJoinError(f.text)));
  const stuck = isHost ? peers.length === 0 : !hostOnline;
  if (kinds.has("password"))
    return {
      tone: "blocked",
      title: "A peer has a different room key",
      detail:
        "Its offers don't decrypt with this link's key. Everyone needs a link from the same board; a board whose .canvas/ was reset has new links.",
    };
  if (kinds.has("ice"))
    return {
      tone: stuck ? "blocked" : "ready",
      title: stuck
        ? "Found peers, but couldn't connect to them"
        : `Connected, but couldn't reach ${failures.length === 1 ? "one peer" : `${failures.length} peers`}`,
      detail:
        "The browsers exchanged offers through the relays, but no network path between them worked. Usual behind VPNs and firewalls that block UDP: it takes a TURN relay. The network test below shows whether this side is the blocked one.",
    };
  if (kinds.has("handshake") || kinds.has("other"))
    return {
      tone: stuck ? "blocked" : "ready",
      title: "A peer connected but failed to join",
      detail: "See the errors below.",
    };

  if (!isHost && !hostOnline)
    return peers.length > 0
      ? {
          tone: "ready",
          title: "Connected to guests, but not the host",
          detail:
            "The host's browser may be closed. If it is open, it may not have this board's host key: ask for a fresh guest link.",
        }
      : {
          tone: "ready",
          title: "Waiting for the host",
          detail:
            "The signalling relays are reachable, but nobody else is in the room yet. The host's browser may be closed, or not reach the relays.",
        };

  if (peers.length === 0)
    return {
      tone: "complete",
      title: "Connected, no guests yet",
      detail: "Share the guest link to invite people.",
    };
  if (snapshot.transport === "relay")
    return {
      tone: "complete",
      title: `Connected to ${peers.length === 1 ? "one peer" : `${peers.length} peers`}`,
      detail: "Through the board's canvas relay, end-to-end encrypted with the board key.",
    };
  const relayed = peers.filter(
    (p) => p.route && describeRoute(p.route).startsWith("relayed"),
  ).length;
  return {
    tone: "complete",
    title: `Connected to ${peers.length === 1 ? "one peer" : `${peers.length} peers`}`,
    detail: relayed
      ? `${relayed} of them through a TURN relay.`
      : "Peer to peer, end-to-end encrypted.",
  };
}
