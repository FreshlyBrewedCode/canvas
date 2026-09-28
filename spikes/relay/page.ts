// ?room=&relay=<ws url>&mode=direct|relay-only  — joins via the ws relay and
// exchanges one message. mode=relay-only forbids non-TURN ICE candidates with no
// TURN server configured: what a network that blocks all UDP / direct paths looks like.
import { joinRoom, selfId } from "@trystero-p2p/ws-relay";
const q = new URLSearchParams(location.search);
const out: any = ((window as any).spike = { selfId, peers: [], got: [], errors: [], t0: performance.now() });
const room = joinRoom(
  {
    appId: "canvas-relay-spike",
    password: "fragment-secret",
    relayConfig: { urls: [q.get("relay")!] },
    ...(q.get("mode") === "relay-only" ? { rtcConfig: { iceServers: [], iceTransportPolicy: "relay" as const } } : {}),
    // mode=turn: relayed candidates only, through our TURN over TCP
    ...(q.get("mode") === "turn"
      ? { rtcConfig: { iceServers: [JSON.parse(q.get("turn")!)], iceTransportPolicy: "relay" as const } }
      : {}),
  },
  q.get("room")!,
  { onJoinError: (e) => out.errors.push(e.error) },
);
const hi = room.makeAction<string>("hi");
hi.onMessage = (d, { peerId }) => out.got.push({ d, peerId });
room.onPeerJoin = (id) => {
  out.peers.push({ id, ms: Math.round(performance.now() - out.t0) });
  void hi.send(`hello from ${selfId}`, { target: id });
};
