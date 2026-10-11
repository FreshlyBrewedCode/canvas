---
title: Relay
description: canvas relay, for networks where people can't connect. Setting it up, deploying and running it.
section: Technical
order: 5
---

Browsers on a board normally connect directly to each other. Some networks don't allow that:
corporate proxies that inspect TLS, VPNs, firewalls that block UDP. The
[connection dialog](/docs/connection) says so: **Found peers, but couldn't connect to them**, or
**No signalling relay reachable**.

A **canvas relay** is a small server you run where every browser can reach it. The board's traffic
then goes through it over one `wss://` connection per browser, like any web app. The relay only
passes messages on: it can't read them and it stores nothing.

## How it works

- **The host puts a board on a relay** with `canvas serve --relay`. Guest links then name the
  relay, so guests set up nothing.
- **Everything goes through the relay** by default: finding each other, the board, agent threads,
  terminals. With `--relay-via signal`, browsers only find each other there and then connect
  directly over WebRTC, as without a relay. That's for networks that block only the public Nostr
  relays.
- **Browsers encrypt everything end to end** with the board's key, which the relay never sees. The
  relay can't read the board, and can't pose as anyone on it.
- **Only people with a token get in.** You give each host (or team) an **issuer key**. From it,
  `canvas serve` signs **relay tokens**: one for the host's tab, and one that guest links carry.
  A token admits one board, for 30 days.
- **One relay serves any number of boards and hosts.**

## Quick start

On a server everyone can reach, with a name and a certificate:

```bash
# An issuer key for each host or team: a name, and a secret you generate.
export CANVAS_RELAY_KEYS="karl:$(openssl rand -base64 32)"
bunx @frebreco/canvas relay                         # listens on 4419
```

Put it behind a proxy that serves `wss://` (see [TLS](#tls)), say at
`wss://relay.example.com`.

On the host's machine, with the issuer key the relay's operator gave you:

```bash
export CANVAS_RELAY=wss://relay.example.com
export CANVAS_RELAY_KEY="karl:<the secret>"
canvas serve
```

Open the host link, **Copy guest link** from **Share**, and send it as usual. The connection dialog shows
**Through the board's canvas relay** and each person's route as **through canvas relay**.

## Settings

Everything is an environment variable. Some have a flag too, which wins. Issuer keys are
environment-only, since flags show up in process lists.

### `canvas relay`

| Variable                      | Flag     | Default   | Effect                                                     |
| ----------------------------- | -------- | --------- | ---------------------------------------------------------- |
| `CANVAS_RELAY_KEYS`           |          | required  | Issuer keys, `name:secret[,name:secret]`. Names: letters, digits, `_`, `-` |
| `CANVAS_RELAY_PORT`           | `--port` | `4419`    | The port it listens on                                     |
| `CANVAS_RELAY_HOST`           | `--host` | `0.0.0.0` | The address it listens on                                  |
| `CANVAS_RELAY_TLS_CERT`       | `--cert` | none      | Serve `wss://` itself with this certificate…               |
| `CANVAS_RELAY_TLS_KEY`        | `--key`  | none      | …and its key                                               |
| `CANVAS_RELAY_MAX_PEERS`      |          | `64`      | People on one board                                        |
| `CANVAS_RELAY_MAX_CONNECTIONS`|          | `256`     | Open connections per issuer                                |
| `CANVAS_RELAY_MAX_MESSAGE_MB` |          | `64`      | One message. A joining guest gets each agent thread in one |
| `CANVAS_RELAY_RATE`           |          | `500`     | Messages per second, per connection                        |
| `CANVAS_RELAY_BANDWIDTH_MB`   |          | `20`      | MB per second, per connection                              |

### `canvas serve`

| Variable           | Flag          | Default     | Effect                                                     |
| ------------------ | ------------- | ----------- | ---------------------------------------------------------- |
| `CANVAS_RELAY`     | `--relay`     | none        | The relay's URL: `wss://…`                                 |
| `CANVAS_RELAY_KEY` | `--relay-key` | none        | Your issuer key, `name:secret`                             |
| `CANVAS_RELAY_VIA` | `--relay-via` | `transport` | `transport`: everything through the relay. `signal`: only finding each other |

## Deploying

### TLS

The web app is served over `https`, so browsers only connect to a relay over `wss://`. The
exception is a relay on the same machine (`ws://127.0.0.1`). Either put the relay behind a
reverse proxy that terminates TLS, or give it a certificate with `--cert` and `--key`.

With [Caddy](https://caddyserver.com), which gets a certificate on its own and passes WebSockets
through:

```
relay.example.com {
  reverse_proxy 127.0.0.1:4419
}
```

Use port 443. Restrictive networks often allow nothing else.

### Docker

The image holds only the relay, as one file:

```bash
docker build -t canvas-relay https://github.com/FreshlyBrewedCode/canvas.git#main
docker run -d --restart unless-stopped -p 127.0.0.1:4419:4419 \
  -e CANVAS_RELAY_KEYS="karl:<secret>,platform:<secret>" canvas-relay
```

It speaks plain `ws://` on 4419 and has a health check. With Caddy in front, in Compose:

```yaml
services:
  relay:
    build: https://github.com/FreshlyBrewedCode/canvas.git#main
    environment:
      CANVAS_RELAY_KEYS: ${CANVAS_RELAY_KEYS}
    restart: unless-stopped
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    restart: unless-stopped
volumes:
  caddy-data: {}
```

In the Caddyfile, `reverse_proxy relay:4419`.

### Sizing

- **Memory and CPU** are small. The relay keeps only who is connected where, and it forwards
  messages without reading them.
- **Bandwidth is the real cost.** With `transport`, all of a board's traffic goes through the
  relay: pointers, board edits, agent output, terminals, files. It comes in once and goes out once
  per person on the board. Joining guests get the whole board and every open thread.
- **Run one instance per relay URL.** A board's people must all reach the same process, so don't
  balance one URL across several instances. For more capacity, run more relays and give hosts
  different URLs.

## Running it

- **Logs** have one line per join: issuer, role (host or guest) and how many are in that room.
  They never contain room names or content.
- **`/health`** answers with the number of rooms, peers and connections: for load balancers,
  uptime checks and the Docker health check.
- **Revoking.** Remove an issuer from `CANVAS_RELAY_KEYS` and restart. Everything it signed stops
  working, including links already shared. To rotate a secret, give the issuer a new one. Its hosts
  then need the new key, and new guest links.
- **Restarting** drops every connection. Browsers reconnect by themselves once it's back.
- **Limits.** A connection over its rate is closed and reconnects. A board over
  `CANVAS_RELAY_MAX_PEERS`, or an issuer over `CANVAS_RELAY_MAX_CONNECTIONS`, is refused, and the
  person sees it in the connection dialog.
- **Expired guest links.** A relay token lasts 30 days from when the host's tab got it.
  **Copy guest link** always gives a fresh one, so re-share the link for boards that run longer.

## What the relay can and can't do

- It **can't read** the board, threads, terminals or files, and can't change them unnoticed. They
  are encrypted with the board's key, which only links carry.
- It **can't pose** as the host or anyone else. Guests still verify the host's signature, and each
  message says who sealed it.
- It **can't replay** a request (say, a prompt) to run it again. Messages carry counters and times,
  and repeats are dropped.
- It **sees** who is on which board (by IP address), when, and how much they send.
- It **can drop or delay** traffic. Everyone on a relayed board depends on it.
- There's **no forward secrecy**: someone who records a relay's traffic and later gets a guest link
  can decrypt what they recorded.
- When the host [resets the invite link](/docs/guests#reset-invite-link), the board moves to a new
  relay room, with new tokens. The relay sees the members leave one room for another, but not the
  new key: the host seals it to each member, so not even a removed member's old key, with the
  relay's help, opens it.
- With `--relay-via signal`, the guest token is part of the relay URL, where proxies may log it.
  It admits only that one board, and the board's key still guards it.
