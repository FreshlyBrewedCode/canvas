---
title: CLI
description: canvas serve and canvas relay, their options and environment.
section: Technical
order: 3
---

```bash
canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME] [--cert FILE] [--key FILE]
             [--pair] [--relay URL] [--relay-key NAME:SECRET] [--relay-via transport|signal]
```

Starts `canvas serve` for a project and prints the host link. Run it with
`bunx @frebreco/canvas serve`, or install `@frebreco/canvas` and run `canvas serve`.

## Options

| Option            | Default                     | Effect                                                    |
| ----------------- | --------------------------- | --------------------------------------------------------- |
| `--dir`           | `.`                         | The project directory: agents, terminals and files work here |
| `--port`          | `4418`                      | The port `canvas serve` listens on                        |
| `--web-url`       | `https://ui.canvas.frebreco.de`, or `…/next` for a pre-release | The web app the host link opens |
| `--tls-host`      | none                        | Serve `wss://` on this host name, on all interfaces       |
| `--cert`, `--key` | `.certs/dev.crt`, `.certs/dev.key` in canvas's own directory | The certificate for `--tls-host` |
| `--pair`          | off                         | Print a fresh pairing code even if a browser is paired already |
| `--relay`         | none                        | Put the board on this [canvas relay](/docs/relay), `wss://…` |
| `--relay-key`     | none                        | The issuer key the relay's operator gave you, `name:secret` |
| `--relay-via`     | `transport`                 | `transport`: everything through the relay. `signal`: only finding each other |

## Environment

| Variable                 | Effect                                                   |
| ------------------------ | -------------------------------------------------------- |
| `CANVAS_WEB_URL`         | Default for `--web-url`                                  |
| `CANVAS_RELAY`           | Default for `--relay`                                    |
| `CANVAS_RELAY_KEY`       | Default for `--relay-key`. Prefer it to the flag, which shows in process lists |
| `CANVAS_RELAY_VIA`       | Default for `--relay-via`                                |
| `CANVAS_OPENCODE_MODEL`  | opencode's model for new sessions (default `opencode-go/big-pickle`) |

## Hosting from another device

By default `canvas serve` listens on `127.0.0.1`, so the host's browser must run on the same
machine. To be the host from another device, for example over a [Tailscale](https://tailscale.com)
network, serve TLS on a name that device can reach:

```bash
tailscale cert --cert-file cert.crt --key-file cert.key machine.tailnet.ts.net
canvas serve --tls-host machine.tailnet.ts.net --cert cert.crt --key cert.key
```

`canvas serve` then listens on all interfaces. Anyone who can reach the port still needs a paired
browser: pair the device with the link `canvas pair` prints.

## Output

```
canvas serving /home/you/src/shop

  pair this browser as host, and open the board:
  https://ui.canvas.frebreco.de/?room=…#k=…&pk=…&server=ws%3A%2F%2F127.0.0.1%3A4418&pair=…
```

While no browser is paired, or with `--pair`, the host link carries a fresh **pairing code**: good
for 10 minutes, and for one browser, which it pairs as the host. Once a browser is paired, the
link has no code, and only paired browsers open it as host; it is the same on every start in the
same directory, as long as `.canvas/room.json` exists.

With `--relay`, it adds which relay peers use. The host link doesn't change: the host's tab gets
its relay token from `canvas serve`.

## canvas pair

```bash
canvas pair [--dir .]
```

Prints a host link with a fresh pairing code, to pair another browser or device as the host. A
`canvas serve` running for the same directory takes the new code at once: the code is kept in
`.canvas/pairing.json`, which `canvas serve` reads on every pairing. A new code replaces the last.
The paired browsers are in `.canvas/owners.json`; delete an entry there to unpair a browser.

## canvas relay

```bash
canvas relay [--port 4419] [--host 0.0.0.0] [--cert FILE --key FILE]
```

Runs a [canvas relay](/docs/relay) for boards on networks where browsers can't connect directly.
It needs `CANVAS_RELAY_KEYS`; every setting and deploying it are on [Relay](/docs/relay#settings).
