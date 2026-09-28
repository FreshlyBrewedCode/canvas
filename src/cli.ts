#!/usr/bin/env bun
/**
 * canvas — a multiplayer canvas for coding agents that run on your machine.
 *
 *   canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME]
 *                [--relay URL] [--relay-key NAME:SECRET] [--relay-via transport|signal]
 *   canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]
 *
 * `serve` starts the local server and prints the link that opens the board as
 * its host. `--tls-host` serves wss:// on that name (with `.certs/dev.{crt,key}`)
 * so a browser on another device can be the host; without it the server only
 * listens on loopback. `--relay` puts the board on a `canvas relay` (ADR 0008)
 * with the issuer key its operator gave you, for everything or only for
 * peers to meet (`--relay-via signal`). Each relay flag has an environment
 * variable: `CANVAS_RELAY`, `CANVAS_RELAY_KEY`, `CANVAS_RELAY_VIA`.
 *
 * `relay` runs a relay for boards on networks where peers can't connect
 * directly; its settings are in `server/relay-config.ts`.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage: canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME]
                    [--relay URL] [--relay-key NAME:SECRET] [--relay-via transport|signal]
       canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]`;

const [command, ...args] = process.argv.slice(2);
if (command === "relay") {
  // Only what the relay needs: no agents, no terminals.
  const { runRelay } = await import("./server/relay-cli");
  runRelay(args, process.env);
} else if (command === "serve") {
  await serveBoard(args);
} else {
  console.log(USAGE);
  process.exit(command === undefined ? 0 : 1);
}

async function serveBoard(args: string[]) {
  const { serve } = await import("./server/server");
  const { defaultWebUrl } = await import("./server/web-url");
  const { parseIssuer } = await import("./server/relay-token");
  const manifest = (await Bun.file(join(import.meta.dir, "../package.json")).json()) as {
    version?: string;
  };
  const env = process.env;
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string", default: "." },
      port: { type: "string", default: "4418" },
      "web-url": { type: "string", default: env.CANVAS_WEB_URL ?? defaultWebUrl(manifest.version) },
      "tls-host": { type: "string" },
      cert: { type: "string", default: join(import.meta.dir, "../.certs/dev.crt") },
      key: { type: "string", default: join(import.meta.dir, "../.certs/dev.key") },
      relay: { type: "string", default: env.CANVAS_RELAY },
      "relay-key": { type: "string", default: env.CANVAS_RELAY_KEY },
      "relay-via": { type: "string", default: env.CANVAS_RELAY_VIA ?? "transport" },
    },
  });
  const fail = (message: string) => {
    console.error(message);
    process.exit(1);
  };

  const dir = resolve(values.dir);
  const tlsHost = values["tls-host"];
  if (tlsHost && !(existsSync(values.cert) && existsSync(values.key)))
    fail(
      `--tls-host needs a certificate: tailscale cert --cert-file ${values.cert} --key-file ${values.key} ${tlsHost}`,
    );

  let relay = null;
  if (values.relay) {
    const via = values["relay-via"];
    if (via !== "transport" && via !== "signal") fail("--relay-via is transport or signal");
    if (!/^wss?:\/\//.test(values.relay)) fail("--relay is the relay's ws:// or wss:// URL");
    // The web app is https: browsers only allow ws:// to their own machine.
    if (
      /^ws:\/\//.test(values.relay) &&
      !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(values.relay)
    )
      console.warn(
        "  warning: browsers on the https web app only reach a relay over wss:// (ws:// only on their own machine)",
      );
    if (!values["relay-key"])
      fail(
        "--relay needs --relay-key NAME:SECRET (or CANVAS_RELAY_KEY), from the relay's operator",
      );
    let issuer;
    try {
      issuer = parseIssuer(values["relay-key"]!);
    } catch (error) {
      fail(`--relay-key: ${error instanceof Error ? error.message : String(error)}`);
    }
    relay = {
      url: values.relay.replace(/\/$/, ""),
      via: via as "transport" | "signal",
      issuer: issuer!,
    };
  }

  const { server, room } = await serve({
    dir,
    port: Number(values.port),
    hostname: tlsHost ? "0.0.0.0" : "127.0.0.1",
    ...(tlsHost && { tls: { cert: values.cert, key: values.key } }),
    ...(manifest.version && { version: manifest.version }),
    ...(relay && { relay }),
  });

  const serverUrl = tlsHost ? `wss://${tlsHost}:${server.port}` : `ws://127.0.0.1:${server.port}`;
  // Secrets ride in the fragment, which browsers never send to the web host.
  // The relay isn't named here: the host tab gets it from `canvas serve`.
  const fragment = new URLSearchParams({
    k: room.key,
    pk: room.hostPublicKey,
    server: serverUrl,
    token: room.token,
  });
  const link = `${values["web-url"].replace(/\/$/, "")}/?room=${room.roomId}#${fragment}`;

  console.log(`canvas serving ${dir}`);
  console.log(`\n  open the board as host:\n  ${link}\n`);
  console.log("  keep this link to yourself — it controls agents on this machine.");
  console.log("  share the guest link from the board instead.\n");
  if (relay)
    console.log(
      `  peers ${relay.via === "transport" ? "connect" : "meet"} through ${relay.url} (${relay.via}).\n`,
    );
}
