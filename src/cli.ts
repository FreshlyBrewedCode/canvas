#!/usr/bin/env bun
/**
 * canvas — a multiplayer canvas for coding agents that run on your machine.
 *
 *   canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME]
 *
 * Starts the local server and prints the link that opens the board as its
 * host. `--tls-host` serves wss:// on that name (with `.certs/dev.{crt,key}`)
 * so a browser on another device of the tailnet can be the host; without it
 * the server only listens on loopback.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "./server/server";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "." },
    port: { type: "string", default: "4418" },
    "web-url": { type: "string", default: process.env.CANVAS_WEB_URL ?? "http://localhost:4417" },
    "tls-host": { type: "string" },
    cert: { type: "string", default: join(import.meta.dir, "../.certs/dev.crt") },
    key: { type: "string", default: join(import.meta.dir, "../.certs/dev.key") },
  },
});

if (positionals[0] !== "serve") {
  console.log("usage: canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME]");
  process.exit(positionals.length === 0 ? 0 : 1);
}

const dir = resolve(values.dir);
const tlsHost = values["tls-host"];
if (tlsHost && !(existsSync(values.cert) && existsSync(values.key))) {
  console.error(`--tls-host needs a certificate: tailscale cert --cert-file ${values.cert} --key-file ${values.key} ${tlsHost}`);
  process.exit(1);
}

const { server, room } = await serve({
  dir,
  port: Number(values.port),
  hostname: tlsHost ? "0.0.0.0" : "127.0.0.1",
  ...(tlsHost && { tls: { cert: values.cert, key: values.key } }),
});

const serverUrl = tlsHost ? `wss://${tlsHost}:${server.port}` : `ws://127.0.0.1:${server.port}`;
// Secrets ride in the fragment, which browsers never send to the web host.
const fragment = new URLSearchParams({ k: room.key, pk: room.hostPublicKey, server: serverUrl, token: room.token });
const link = `${values["web-url"].replace(/\/$/, "")}/?room=${room.roomId}#${fragment}`;

console.log(`canvas serving ${dir}`);
console.log(`\n  open the board as host:\n  ${link}\n`);
console.log("  keep this link to yourself — it controls agents on this machine.");
console.log("  share the guest link from the board instead.\n");
