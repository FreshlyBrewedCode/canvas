/**
 * `canvas relay` (ADR 0008): its flags and environment (`relay-config.ts`),
 * then the server. Also the entry of the Docker image (`relay-main.ts`), so it
 * pulls in nothing `canvas serve` needs.
 */

import { parseArgs } from "node:util";

import { startRelay } from "./relay";
import { relayConfig } from "./relay-config";

export const RELAY_USAGE =
  "canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]   (CANVAS_RELAY_KEYS=name:secret,…)";

export function runRelay(args: string[], env: Readonly<Record<string, string | undefined>>) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });
  let config;
  try {
    config = relayConfig(env, values);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`usage: ${RELAY_USAGE}`);
    process.exit(1);
  }
  const server = startRelay({ ...config, log: (line) => console.log(line) });
  const scheme = config.tls ? "wss" : "ws";
  console.log(
    `canvas relay on ${scheme}://${config.hostname}:${server.port} for ${[...config.issuers.keys()].join(", ")}`,
  );
  const { limits } = config;
  console.log(
    `  limits: ${limits.peersPerRoom} peers a room, ${limits.connectionsPerIssuer} connections an issuer, ` +
      `${limits.maxMessage / 1024 / 1024} MB a message, ${limits.messagesPerSecond} messages and ` +
      `${limits.bytesPerSecond / 1024 / 1024} MB a second a connection`,
  );
  if (!config.tls) console.log("  no TLS here: put it behind a proxy that serves wss://");
  // Containers stop with SIGTERM: close the connections, peers reconnect elsewhere or later.
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      void server.stop(true).then(() => process.exit(0));
    });
  return server;
}
