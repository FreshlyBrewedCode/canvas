canvas

- a multiplayer canvas (think Miro) whose frames are coding-agent sessions, files of the
  project, browser previews and terminals — the agents run **on one person's machine**, everyone
  else joins peer to peer. Prototype stage: proving the concept, not hardening it
- two halves
  1. **`canvas serve`** (`src/cli.ts`, `src/server/`) — Bun server started in the project dir:
     ACP agent sessions, read-only files of the shared set, PTYs, persistence under
     `<dir>/.canvas/`. One token-guarded WebSocket, used only by the host's browser
  2. **web app** (`src/web/`) — Vite/React SPA standing in for the publicly hosted UI; peers
     meet over trystero (Nostr), the board is a Yjs doc
- `src/shared/protocol.ts` is the wire contract of both halves; the trust model is ADR 0001 (the
  host's browser is the only door to the machine; star for authority, mesh for presence) and
  ADR 0002 (files reach guests read-only, from a set `canvas serve` fixes — `shared-set.ts`).
  Anything a board path names comes from a guest: resolve it through the shared set. So does a
  browser frame's URL: ADR 0004 (loopback loads for the host only, http(s) only, HTML files
  render in a sandboxed `srcdoc` — `web/lib/browser-url.ts`)
- agents act on the board (ADR 0003): `canvas serve` gives each session an MCP server
  (`board-mcp.ts`) whose calls the host's browser runs (`web/lib/board-tools.ts`); priming is
  MCP server instructions, never a replaced system prompt (finding 06). Layout rules — clusters
  and rows read off positions — are pure geometry in `src/shared/layout.ts`
- frame focus (finding 08): who occupies a frame is presence (`web/lib/focus.ts`); the occupant
  drives its scroll for everyone following (`hooks/use-follow-scroll.ts`), agents occupy the
  frame they last opened or changed until their turn ends

- stack (siblings: `../factory`, `../wayful`)
  - bun, TypeScript, React 19, Vite, tailwind v4, shadcn-style primitives; design system copied
    from wayful (`docs/design/design.md`)
  - ACP via `@agentclientprotocol/sdk`, one connection per agent session so model / effort /
    mode (ACP session config options) can change any time; AG-UI chunks from `@tanstack/ai-acp`'s
    `translateAcpStream`, folded by `@tanstack/ai`'s `StreamProcessor` (finding 04) — any ACP
    agent works; `claude` via `@agentclientprotocol/claude-agent-acp`, `opencode acp`
  - trystero 0.25 (object action API — see finding 02), yjs, y-protocols awareness,
    y-codemirror.next, xterm
  - files frame (finding 05): `@pierre/trees` (file tree), `@pierre/diffs` `File` (Shiki,
    virtualized source view), react-markdown, shadcn Resizable on react-resizable-panels v4
  - deliberately not (yet): Effect, TanStack Router/Query — the server is a thin relay and the
    app has one screen. Revisit when hardening

- working in this repo
  - `bun run check` = format:check + lint + typecheck + test
  - dev: `bun run dev` (Vite on :4417) and `bun src/cli.ts serve --dir <project>`. To reach it
    from other devices: `CANVAS_DEV_HOST=<name>` in a local `.env`, a cert for it in
    `.certs/dev.{crt,key}`, then `serve --tls-host <name> --web-url https://<name>:4417`. Machine
    names and certs stay local, never in the repo
  - browser automation through `nix develop` (playwright libs); `e2e/drive.ts <host link>` drives
    a host and a guest (`STEP=basic|approve|extras|selection|claude|config|files|tools|lines|
    layout|arrange|resume|focus|focus-agent|preview|scratch`; `files` wants the scratch repo of
    finding 05, `tools`/`lines`/`scratch` the one of finding 07, `focus`/`focus-agent` a long file
    and a long markdown file, finding 08, `preview` an HTML file and a loopback server, finding 09)
  - conventional commits; spike → prototype → validate → harden
  - releases (semantic-release, as in factory): PRs are squash-merged, their title is the commit
    semantic-release reads. Every merge to `main` publishes `@frebreco/canvas@next` and deploys its
    web app to `ui.canvas.frebreco.de/next`; `release.yml` by hand publishes `latest` and deploys
    to `ui.canvas.frebreco.de` (`ui.yml` pushes to the `canvas-ui` repo, whose Pages serve it). The
    published CLI opens its own channel's web app (`src/server/web-url.ts`). The package is staged
    by `scripts/build-release.ts`; `site.yml` deploys `site/` to `canvas.frebreco.de`. One-time
    setup: `scripts/bootstrap-release.sh`

- docs: `docs/adr/` decisions, `docs/findings/` spike and validation evidence; `site/` the public
  landing page and user docs (Astro, own package, see `site/README.md`). A user-visible change
  updates the page in `site/content/docs/` that describes it, in the terms of its Glossary
