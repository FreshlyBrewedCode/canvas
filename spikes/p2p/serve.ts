import page from "./index.html";
const https = Bun.serve({
  port: 5199,
  hostname: "0.0.0.0",
  tls: { cert: Bun.file(".certs/dev.crt"), key: Bun.file(".certs/dev.key") },
  development: false,
  routes: { "/": page },
});
const local = Bun.serve({
  port: 5198,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    return new Response("pong", { headers: { "access-control-allow-origin": "*" } });
  },
  websocket: { open: (ws) => ws.send("hello-from-local"), message() {} },
});
console.log("https", https.url.href, "local", local.url.href);
