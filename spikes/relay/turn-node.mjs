// TURN on Bun: `turn-server` (pure JS) over TCP, TURN REST shared-secret
// credentials. IP = the machine's LAN address (loopback peers are refused).
import { createServer } from "turn-server";
const ip = process.env.IP ?? "192.168.1.55";
const server = createServer({
  auth: { mechanism: "long-term", realm: "canvas", secret: "spike-secret" },
  relay: { ip, externalIp: ip },
});
server.on("listening", (info) => console.log("turn listening", JSON.stringify(info)));
server.on("error", (e) => console.log("turn error", e));
server.listen({ port: 3481 });

