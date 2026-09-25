canvas

- a multiplayer canvas (think Miro) whose frames are coding-agent sessions, markdown artifacts,
  browser previews and terminals — the agents run **on one person's machine**, everyone else
  joins peer to peer. Prototype stage: proving the concept, not hardening it
- two halves
  1. **`canvas serve`** (`src/cli.ts`, `src/server/`) — Bun server started in the project dir:
     ACP agent sessions, watched markdown files, PTYs, persistence under `<dir>/.canvas/`.
     One token-guarded WebSocket, used only by the host's browser
  2. **web app** (`src/web/`) — Vite/React SPA standing in for the publicly hosted UI; peers
     meet over trystero (Nostr), the board is a Yjs doc
- `src/shared/protocol.ts` is the wire contract of both halves; ADR 0001 is the trust model
  (the host's browser is the only door to the machine; star for authority, mesh for presence)

- stack (siblings: `../factory`, `../wayful`)
  - bun, TypeScript, React 19, Vite, tailwind v4, shadcn-style primitives; design system copied
    from wayful (`docs/design/design.md`)
  - `@tanstack/ai` + `@tanstack/ai-acp` (`acpCompatible`) + `@tanstack/ai-sandbox-local-process`
    — any ACP agent works; `claude` via `@agentclientprotocol/claude-agent-acp`, `opencode acp`
  - trystero 0.25 (object action API — see finding 02), yjs, y-protocols awareness,
    y-codemirror.next, xterm
  - deliberately not (yet): Effect, TanStack Router/Query — the server is a thin relay and the
    app has one screen. Revisit when hardening

- working in this repo
  - `bun run check` = format:check + lint + typecheck + test
  - dev: `bun run dev` (Vite on :4417, https with `.certs/` from `tailscale cert`) and
    `bun src/cli.ts serve --dir <project> --tls-host dev.example.ts.net --web-url https://dev.example.ts.net:4417`
  - browser automation through `nix develop` (playwright libs); `e2e/drive.ts <host link>` drives
    a host and a guest (`STEP=basic|approve|extras|selection|claude`)
  - conventional commits; spike → prototype → validate → harden

- docs: `docs/adr/` decisions, `docs/findings/` spike and validation evidence
