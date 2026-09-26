---
title: CLI
description: canvas serve, its options and environment.
section: Technical
order: 3
---

```bash
canvas serve [--dir .] [--port 4418] [--web-url URL] [--tls-host NAME] [--cert FILE] [--key FILE]
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

## Environment

| Variable                 | Effect                                                   |
| ------------------------ | -------------------------------------------------------- |
| `CANVAS_WEB_URL`         | Default for `--web-url`                                  |
| `CANVAS_OPENCODE_MODEL`  | opencode's model for new sessions (default `opencode-go/big-pickle`) |

## Hosting from another device

By default `canvas serve` listens on `127.0.0.1`, so the host's browser must run on the same
machine. To be the host from another device, for example over a [Tailscale](https://tailscale.com)
network, serve TLS on a name that device can reach:

```bash
tailscale cert --cert-file cert.crt --key-file cert.key machine.tailnet.ts.net
canvas serve --tls-host machine.tailnet.ts.net --cert cert.crt --key cert.key
```

`canvas serve` then listens on all interfaces. Anyone who can reach the port still needs the token.

## Output

```
canvas serving /home/you/src/shop

  open the board as host:
  https://ui.canvas.frebreco.de/?room=…#k=…&pk=…&server=ws%3A%2F%2F127.0.0.1%3A4418&token=…
```

The link is the same on every start in the same directory, as long as `.canvas/room.json` exists.
