#!/usr/bin/env bun
/**
 * canvas — a multiplayer canvas for coding agents that run on your machine.
 *
 *   canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME] [--pair]
 *                [--relay URL] [--relay-key NAME:SECRET] [--relay-via transport|signal]
 *   canvas pair  [--dir .]
 *   canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]
 *
 * `serve` starts the local server and prints the link that opens the board as
 * its host. While no browser is paired, or with `--pair`, the link carries a
 * pairing code (ADR 0011): good for 10 minutes and once, it makes the browser
 * that opens it the board's owner. `pair` prints a fresh code for another
 * device; a running `serve` for the same dir reads it from `.canvas/pairing.json`.
 * `--tls-host` serves wss:// on that name (with `.certs/dev.{crt,key}`) so a
 * browser on another device can be the host; without it the server only
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
import type { RoomSecrets } from "./shared/protocol";
import type { ServeInfo } from "./server/store";

const USAGE = `usage: canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME] [--pair]
                    [--relay URL] [--relay-key NAME:SECRET] [--relay-via transport|signal]
       canvas pair  [--dir .]
       canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]`;

const [command, ...args] = process.argv.slice(2);
if (command === "relay") {
  // Only what the relay needs: no agents, no terminals.
  const { runRelay } = await import("./server/relay-cli");
  runRelay(args, process.env);
} else if (command === "serve") {
  await serveBoard(args);
} else if (command === "pair") {
  await pairDevice(args);
} else {
  console.log(USAGE);
  process.exit(command === undefined ? 0 : 1);
}

async function serveBoard(args: string[]) {
  const { serve } = await import("./server/server");
  const { defaultWebUrl } = await import("./server/web-url");
  const { parseIssuer } = await import("./server/relay-token");
  const { Store } = await import("./server/store");
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
      pair: { type: "boolean", default: false },
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

  const { server, room, pairing } = await serve({
    dir,
    port: Number(values.port),
    hostname: tlsHost ? "0.0.0.0" : "127.0.0.1",
    ...(tlsHost && { tls: { cert: values.cert, key: values.key } }),
    ...(manifest.version && { version: manifest.version }),
    ...(relay && { relay }),
    pair: values.pair,
  });

  const info = {
    webUrl: values["web-url"].replace(/\/$/, ""),
    server: tlsHost ? `wss://${tlsHost}:${server.port}` : `ws://127.0.0.1:${server.port}`,
  };
  // For `canvas pair`, which prints links to this server.
  new Store(dir).saveServeInfo(info);

  console.log(`canvas serving ${dir}`);
  if (pairing) {
    console.log(
      `\n  pair this browser as host, and open the board:\n  ${hostLink(room, info, pairing)}\n`,
    );
    console.log("  the link pairs one browser, within 10 minutes; keep it to yourself.");
  } else {
    console.log(`\n  open the board as host (in a paired browser):\n  ${hostLink(room, info)}\n`);
    console.log("  another browser or device: canvas pair");
  }
  console.log("  share the guest link from the board instead.\n");
  if (relay)
    console.log(
      `  peers ${relay.via === "transport" ? "connect" : "meet"} through ${relay.url} (${relay.via}).\n`,
    );
}

/** A fresh pairing code for another browser, read by a running `serve` too. */
async function pairDevice(args: string[]) {
  const { Owners } = await import("./server/owners");
  const { Store } = await import("./server/store");
  const { values } = parseArgs({ args, options: { dir: { type: "string", default: "." } } });
  const dir = resolve(values.dir);
  const root = join(dir, ".canvas");
  if (!existsSync(join(root, "room.json")) || !existsSync(join(root, "serve.json"))) {
    console.error(`no board in ${dir} yet: start canvas serve there first`);
    process.exit(1);
  }
  const store = new Store(dir);
  const info = store.serveInfo()!;
  const link = hostLink(await store.room(), info, new Owners(store.root).pair());
  console.log(`\n  pair a browser as host of ${dir}:\n  ${link}\n`);
  console.log("  good for 10 minutes and one browser; canvas serve must be running to use it.\n");
}

/**
 * The link that opens the board as host. Secrets ride in the fragment, which
 * browsers never send to the web host. The relay isn't named here: the host
 * tab gets it from `canvas serve`.
 */
function hostLink(room: RoomSecrets, info: ServeInfo, pair?: string) {
  const fragment = new URLSearchParams({
    k: room.key,
    pk: room.hostPublicKey,
    server: info.server,
    ...(pair && { pair }),
  });
  return `${info.webUrl}/?room=${room.roomId}#${fragment}`;
}
