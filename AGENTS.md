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
  Anything a board path names comes from a guest: resolve it through the shared set
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
  - dev: `bun run dev` (Vite on :4417, https with `.certs/` from `tailscale cert`) and
    `bun src/cli.ts serve --dir <project> --tls-host dev.example.ts.net --web-url https://dev.example.ts.net:4417`
  - browser automation through `nix develop` (playwright libs); `e2e/drive.ts <host link>` drives
    a host and a guest (`STEP=basic|approve|extras|selection|claude|config|files|tools|lines|
    layout|resume|focus|focus-agent`; `files` wants the scratch repo of finding 05, `tools`/`lines`
    the one of finding 07, `focus`/`focus-agent` a long file and a long markdown file, finding 08)
  - conventional commits; spike → prototype → validate → harden

- docs: `docs/adr/` decisions, `docs/findings/` spike and validation evidence
