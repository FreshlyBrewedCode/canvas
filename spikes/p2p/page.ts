// Spike 2 page: trystero peer discovery + a Yjs doc synced over trystero
// actions + reaching the "local CLI server" (plain http/ws on 127.0.0.1) from
// an https origin.
import { joinRoom, selfId } from "trystero";
import * as Y from "yjs";

const params = new URLSearchParams(location.search);
const room = params.get("room")!;
const localPort = params.get("local");
const out: Record<string, unknown> = { selfId, t0: performance.now() };
(window as any).spike = out;

const doc = new Y.Doc();
const r = joinRoom({ appId: "canvas-spike", password: "pw-" + room }, room, {
  onJoinError: (d) => ((out.joinError = String(d.error))),
});
const upd = r.makeAction<Uint8Array>("yupd");
const sv = r.makeAction<Uint8Array>("ysv");

doc.on("update", (u: Uint8Array, origin: unknown) => {
  if (origin !== "remote") void upd.send(u);
});
upd.onMessage = (u) => Y.applyUpdate(doc, new Uint8Array(u), "remote");
sv.onMessage = (v, { peerId }) =>
  void upd.send(Y.encodeStateAsUpdate(doc, new Uint8Array(v)), { target: peerId });

r.onPeerJoin = (peer) => {
  out.peerJoinedMs = Math.round(performance.now() - (out.t0 as number));
  out.peer = peer;
  void sv.send(Y.encodeStateVector(doc), { target: peer });
};

doc.getArray<string>("items").push([`from-${selfId}`]);
(window as any).ydoc = doc;
(window as any).items = () => doc.getArray<string>("items").toArray();

if (localPort) {
  fetch(`http://127.0.0.1:${localPort}/ping`)
    .then((res) => res.text())
    .then((t) => (out.fetchLocal = t))
    .catch((e) => (out.fetchLocal = "ERR " + e));
  const ws = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
  ws.onmessage = (e) => (out.wsLocal = e.data);
  ws.onerror = () => (out.wsLocal = "ERR");
}
