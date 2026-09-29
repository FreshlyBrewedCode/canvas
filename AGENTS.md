canvas

- a multiplayer canvas (think Miro) whose frames are coding-agent sessions, files of the
  project, browser previews, terminals and Excalidraw drawings — the agents run **on one person's machine**, everyone
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
- comments (ADR 0006, finding 13): a file frame's comments live in `comments:<frameId>`, found
  again by their quoted lines (`shared/comments.ts`, `web/lib/comments.ts`); the source view's
  gutter "+" and cards come from `@pierre/diffs` line annotations. Agents read them with
  `view_frame`, and `canvas serve` quotes the lines of theirs
- links (ADR 0007, finding 14): markdown and HTML links name places on the board;
  `web/lib/board-link.ts` parses them, `web/lib/navigate.ts` goes there. Going is the clicker's
  own (view, focus, lines as their selection); what a frame shows stays shared. HTML previews hand
  links over a token-guarded `postMessage` bridge (`web/lib/link-bridge.ts`)
- agent skills (finding 12): `skills/` ships with the package; every session gets it as a Claude
  plugin (`.claude-plugin/plugin.json` points `skills` at the folder itself) and an opencode
  skills path, and the board priming names each skill. A new skill is a `skills/<name>/SKILL.md`
  whose `name` is the folder's; nothing to register. Its description is priming too: keep it
  short, with its trigger. User-visible: add it to `site/content/docs/skills.md`
- drawings (ADR 0009, finding 17): a drawing frame's Excalidraw elements live in
  `drawing:<frameId>`, newer `version` wins (`web/lib/drawing.ts`). At rest an SVG; editing is
  Excalidraw with the board's CSS scale undone (it can't live under one) and its own zoom set to
  it (`components/drawing-editor.tsx`, lazy: Excalidraw is large). Agents' elements and mermaid
  become Excalidraw's, and `view_frame`'s image is rendered, in the host's browser around the
  sync tool call (`web/lib/drawing-kit.ts`); `board-result` carries images
- canvas relay (ADR 0008, findings 15–16): `room.ts` reaches peers through a `Transport`
  (`web/lib/transport/`): trystero on Nostr (default), trystero meeting on a relay, or everything
  through `canvas relay` (`server/relay.ts`), sealed with the board key (`transport/envelope.ts`).
  The relay admits tokens `canvas serve` signs with an issuer key (`server/relay-token.ts`), sent
  to the host tab in `welcome`. Settings are environment variables (`server/relay-config.ts`);
  `Dockerfile` is the relay alone. User docs: `site/content/docs/relay.md`
- frame focus (finding 08): who occupies a frame is presence (`web/lib/focus.ts`); the occupant
  drives its scroll for everyone following (`hooks/use-follow-scroll.ts`), agents occupy the
  frame they last opened or changed until their turn ends. A file frame's tree panel follows too
  (finding 18, `hooks/use-follow-tree.ts`)
- where everyone is (finding 19): each peer's view (the board rectangle it shows) is presence,
  throttled; people out of view get a marker on the viewport's edge (`edgeMarker`, `viewport.ts`).
  Clicking an avatar follows that view until our own pan or zoom (`hooks/use-follow-view.ts`) —
  not frame focus's following, which is an occupant's scroll

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
  - drawing frame (finding 17): `@excalidraw/excalidraw` 0.18, `@excalidraw/mermaid-to-excalidraw`;
    its fonts are served by the app (`vite.config.ts`), not its CDN
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
    layout|arrange|resume|focus|focus-agent|focus-tree|presence|preview|scratch|lists|comments|comments-agent|
    takeover|version|links|drawing|drawing-agent|connection|relay|pan`; `files` wants the scratch repo of finding 05, `tools`/`lines`/`scratch`/
    `lists` the one of finding 07, `focus`/`focus-agent` a long file and a long markdown file,
    finding 08, `focus-tree` nested folders, finding 18, `preview` an HTML file and a loopback server, finding 09, `comments`/
    `comments-agent` the repo of finding 13, `links` the one of finding 14, `relay` a `canvas relay`
    and `serve --relay`; `IDLE_MS` gives slow agents longer than 4 min per
    prompt)
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
