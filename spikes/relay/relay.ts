// A trystero signalling relay on Bun's native pub/sub — the wire protocol of
// `@trystero-p2p/ws-relay/server` ({type: subscribe|unsubscribe|publish, topic,
// payload} in, {topic, payload} out) without its `ws` dependency. Also serves
// the spike page. Logs what an operator would see.
import page from "./index.html";

const seen = { sockets: 0, topics: new Set<string>(), publishes: 0, sample: "" as string };
const server = Bun.serve({
  port: Number(process.env.PORT ?? 5210),
  hostname: "127.0.0.1",
  development: false,
  routes: { "/": page, "/seen": () => Response.json({ ...seen, topics: [...seen.topics] }) },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/relay" && server.upgrade(req, { data: {} })) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open() {
      seen.sockets++;
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw)) as { type: string; topic: string; payload?: unknown };
      if (typeof msg.topic !== "string") return;
      seen.topics.add(msg.topic);
      if (msg.type === "subscribe") ws.subscribe(msg.topic);
      else if (msg.type === "unsubscribe") ws.unsubscribe(msg.topic);
      else if (msg.type === "publish") {
        seen.publishes++;
        if (!seen.sample && JSON.stringify(msg.payload).length > 200) seen.sample = JSON.stringify(msg.payload).slice(0, 300);
        server.publish(msg.topic, JSON.stringify({ topic: msg.topic, payload: msg.payload }));
      }
    },
  },
});
console.log("relay", server.url.href);
