# canvas

**A multiplayer canvas whose frames are coding-agent sessions, files, browser previews and
terminals.** The agents run on one person's machine; everyone else joins peer to peer from the
browser.

```bash
cd your-project
bunx @frebreco/canvas serve
```

`canvas serve` prints a host link. Open it, then share the guest link from the board. Requires
[Bun](https://bun.sh) and at least one ACP agent: `claude` (Claude Code) or `opencode`.

Docs: **[canvas.frebreco.de](https://canvas.frebreco.de)** —
[quick start](https://canvas.frebreco.de/docs/quick-start),
[security](https://canvas.frebreco.de/docs/security),
[architecture](https://canvas.frebreco.de/docs/architecture).

> **A prototype.** canvas is proving a concept, not hardened. The host link controls agents on
> your machine: never share it. Read [security](https://canvas.frebreco.de/docs/security) before
> inviting anyone you would not hand a shell.

## Releases

| Channel  | Install                         | Web app                              |
| -------- | ------------------------------- | ------------------------------------ |
| `latest` | `bunx @frebreco/canvas serve`   | https://ui.canvas.frebreco.de        |
| `next`   | `bunx @frebreco/canvas@next serve` | https://ui.canvas.frebreco.de/next |

Every merge to `main` publishes a `next` pre-release; stable releases are cut by hand. Each channel
opens the web app built from the same commit, so both halves speak the same protocol.

## Development

```bash
bun install
bun run dev                          # the web app, Vite on :4417
bun src/cli.ts serve --dir <project> # the local server, prints a link to :4417
bun run check                        # format, lint, typecheck, test
```

`AGENTS.md` is the repo guide; `docs/adr/` holds the decisions, `docs/findings/` the evidence,
`site/` the landing page and docs. Commits and PR titles follow
[Conventional Commits](https://www.conventionalcommits.org): PRs are squash-merged and their title
decides the next version.

## License

MIT
