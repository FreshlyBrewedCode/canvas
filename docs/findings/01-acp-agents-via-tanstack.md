# 01 — ACP agents through `@tanstack/ai-acp` (spike)

Date: 2026-09-25 · Script: `spikes/01-acp-opencode.ts` · Versions: `@tanstack/ai` 0.61.0,
`@tanstack/ai-acp` 0.3.17, `@tanstack/ai-sandbox` 0.5.15, `-local-process` 0.2.6,
opencode 1.18.31, Claude Code 2.1.280 via `@agentclientprotocol/claude-agent-acp` 0.81.

## Question

Can one generic adapter (`acpCompatible`) drive real coding agents on the host, so any
ACP-speaking agent "just works" — rather than the opencode-specific adapter factory uses?

## Result: yes, for both agents tried

| | opencode (`opencode acp`) | Claude Code (`bunx @agentclientprotocol/claude-agent-acp`) |
|---|---|---|
| streams AG-UI chunks through `chat()` | yes (text, reasoning, tool calls) | yes |
| session id emitted as `CUSTOM <name>.session-id` | yes | yes |
| 2nd turn with `modelOptions.sessionId` resumes | yes — recalled the file it made | yes |
| async `onPermissionRequest` gates a tool call | yes (when config says `ask`) | yes (asks for `Write` by default) |
| turn latency (small task) | ~10 s | ~25 s first turn (bunx cold), ~3 s follow-up |

- The adapter needs **no** agent-specific code: `command` is the only difference.
- `onPermissionRequest` may return a Promise: the turn simply blocks until it resolves. This
  is what lets a browser user approve a tool call on the host's machine — the server parks
  the promise and resolves it when the host clicks Allow/Deny.
- Options offered differ by agent (`once/always/reject` vs `allow-once/allow-with-updates/reject`)
  but all carry the ACP `kind` (`allow_once`, `allow_always`, `reject_once`, …) — UI keys off `kind`.
- opencode's model is set with `OPENCODE_CONFIG_CONTENT` (no `-m` flag on `opencode acp`);
  its permission policy goes in the same JSON (`permission: {edit: "ask", bash: "ask"}`).
- `authMode: "host"` uses the CLI's own login (no API keys needed).

## Gotchas

- **Don't pass an absolute host path as `cwd`.** `cwd` is the *virtual* sandbox path
  (default `/workspace`, which `localProcessSandbox({dir})` maps to `dir`). An absolute host
  path gets nested under the workspace: the spike produced `data/src/canvas/…/.tanstack-projected-*`
  inside the work dir. (factory's `.gitignore` carries `data/` and `.tanstack-projected-*`,
  which suggests it hits the same thing.)
- The sandbox writes a `.tanstack-projected-<hash>` file into the workspace — gitignore it.
