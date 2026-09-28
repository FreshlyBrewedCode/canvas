import { describe, expect, test } from "bun:test";

import {
  classifyJoinError,
  describeRoute,
  diagnose,
  readProbe,
  RELAY_GRACE_MS,
  routeOf,
  type ConnectionSnapshot,
  type PeerInfo,
} from "./connection";

const ICE =
  "could not connect to peer p2 after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers";

const peer = (peerId: string, patch: Partial<PeerInfo> = {}): PeerInfo => ({
  peerId,
  host: false,
  connectionState: "connected",
  iceConnectionState: "connected",
  route: null,
  ...patch,
});

const guest = (patch: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot => ({
  now: 100_000,
  isHost: false,
  transport: "p2p",
  serveStatus: null,
  joinedAt: 100_000 - RELAY_GRACE_MS - 1,
  relays: [{ url: "wss://a", state: "open" }],
  peers: [],
  hostOnline: false,
  log: [],
  ...patch,
});

describe("classifyJoinError", () => {
  test("tells trystero's join errors apart", () => {
    expect(classifyJoinError(ICE)).toBe("ice");
    expect(classifyJoinError("incorrect room password when decrypting offer")).toBe("password");
    expect(classifyJoinError("handshake timed out after 10000ms")).toBe("handshake");
    expect(classifyJoinError("something else")).toBe("other");
  });
});

describe("routeOf", () => {
  const stats = (entries: Record<string, unknown>[]) =>
    new Map(entries.map((e) => [e.id as string, e as never]));

  test("follows the transport's selected pair to both candidates", () => {
    const route = routeOf(
      stats([
        { id: "T", type: "transport", selectedCandidatePairId: "P" },
        {
          id: "P",
          type: "candidate-pair",
          localCandidateId: "L",
          remoteCandidateId: "R",
          currentRoundTripTime: 0.0421,
          bytesSent: 10,
          bytesReceived: 20,
        },
        {
          id: "L",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "tls",
          address: "203.0.113.5",
          port: 3478,
        },
        { id: "R", type: "remote-candidate", candidateType: "srflx", protocol: "udp" },
      ]),
    );
    expect(route).toEqual({
      local: {
        type: "relay",
        protocol: "udp",
        relayProtocol: "tls",
        address: "203.0.113.5",
        port: 3478,
      },
      remote: { type: "srflx", protocol: "udp" },
      rtt: 42,
      bytesSent: 10,
      bytesReceived: 20,
    });
    expect(describeRoute(route!)).toBe("relayed via TURN (TLS)");
  });

  test("is null before a pair is selected", () => {
    expect(routeOf(stats([{ id: "T", type: "transport" }]))).toBeNull();
  });

  test("names direct routes by candidate type", () => {
    const direct = (a: string, b: string) =>
      describeRoute({
        local: { type: a as never, protocol: "udp" },
        remote: { type: b as never, protocol: "udp" },
      });
    expect(direct("host", "host")).toBe("direct, same network (UDP)");
    expect(direct("srflx", "prflx")).toBe("direct through NAT (UDP)");
  });
});

describe("readProbe", () => {
  const probe = (host: number, srflx: number) => ({
    candidates: { host, srflx, prflx: 0, relay: 0 },
    durationMs: 1,
  });

  test("UDP gets out when a STUN server answered", () => {
    expect(readProbe(probe(2, 1)).tone).toBe("complete");
  });

  test("only local candidates mean STUN is blocked", () => {
    expect(readProbe(probe(2, 0))).toMatchObject({ tone: "blocked" });
    expect(readProbe(probe(2, 0)).text).toContain("TURN");
  });
});

describe("diagnose", () => {
  test("a host without canvas serve says so first", () => {
    const headline = diagnose(guest({ isHost: true, serveStatus: "closed" }));
    expect(headline).toMatchObject({ tone: "blocked", title: "Can't reach canvas serve" });
  });

  test("no relay open is pending at first, then blocked", () => {
    const closed = [{ url: "wss://a", state: "closed" as const }];
    expect(diagnose(guest({ relays: closed, joinedAt: 99_000 })).tone).toBe("pending");
    expect(diagnose(guest({ relays: closed }))).toMatchObject({
      tone: "blocked",
      title: "No signalling relay reachable",
    });
  });

  test("found peers but no network path: WebRTC is blocked", () => {
    const log = [
      { at: 1, level: "error" as const, source: "peer" as const, text: ICE, peerId: "p2" },
    ];
    expect(diagnose(guest({ log }))).toMatchObject({
      tone: "blocked",
      title: "Found peers, but couldn't connect to them",
    });
  });

  test("a failure with a peer that connected since is over", () => {
    const log = [
      { at: 1, level: "error" as const, source: "peer" as const, text: ICE, peerId: "p2" },
    ];
    const headline = diagnose(
      guest({ log, peers: [peer("p2", { host: true })], hostOnline: true }),
    );
    expect(headline.tone).toBe("complete");
  });

  test("connected to the host but not to another peer is a warning", () => {
    const log = [
      { at: 1, level: "error" as const, source: "peer" as const, text: ICE, peerId: "p3" },
    ];
    const headline = diagnose(
      guest({ log, peers: [peer("p2", { host: true })], hostOnline: true }),
    );
    expect(headline).toMatchObject({
      tone: "ready",
      title: "Connected, but couldn't reach one peer",
    });
  });

  test("relays open, nobody there: waiting for the host", () => {
    expect(diagnose(guest()).title).toBe("Waiting for the host");
  });

  test("counts peers relayed through TURN", () => {
    const relayed = peer("p2", {
      route: {
        local: { type: "relay", protocol: "udp", relayProtocol: "tcp" },
        remote: { type: "host", protocol: "udp" },
      },
    });
    const headline = diagnose(guest({ peers: [relayed, peer("p3")], hostOnline: true }));
    expect(headline).toMatchObject({ tone: "complete", title: "Connected to 2 peers" });
    expect(headline.detail).toContain("1 of them through a TURN relay");
  });
});
