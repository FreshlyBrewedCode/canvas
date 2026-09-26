# 04 — Picking model, reasoning effort, … over ACP

Date: 2026-09-26 · Scripts: `spikes/02-acp-config-options.ts` (raw ACP),
`spikes/03-agent-manager-config.ts` (`AgentManager` end to end), `e2e/drive.ts` `STEP=config`.
Versions: `@agentclientprotocol/sdk` 1.5.0, `@agentclientprotocol/claude-agent-acp` 0.81.2
(Claude Code 2.1.280), opencode 1.18.31, `@tanstack/ai-acp` 0.3.17.

## Question

Can an agent frame list the models (and reasoning effort, context size, …) an agent offers and
switch between them at any time — through ACP and the TanStack setup, for any agent?

## ACP has this: session config options

`session/new` and `session/load` return `configOptions`; `session/set_config_option` changes
one and answers with the **full, updated list**; agents push `config_option_update` when it
changes on their side. Each option is a `select` (or `boolean`) with an optional `category`
(`model`, `thought_level`, `model_config`, `mode`) that exists only for UX placement. Both
agents use exactly this (the older `unstable_setSessionModel` / `models` field: neither sends it).

| | Claude Code | opencode |
|---|---|---|
| `model` | 5 (`default`, `opus`, `claude-fable-5-1[1m]`, `sonnet`, `haiku`) — the account's `/model` list | ~700: every model of every configured provider (`opencode-go/glm-5.3`, …) |
| `thought_level` | `effort`: default/low/medium/high/xhigh/max — **only once a model supports it** (none for Haiku) | `effort`: per model, e.g. GLM low/high/max, GPT none…max |
| `model_config` | `fast` on/off (models that support it) | — |
| `mode` | Manual / Accept edits / Plan / Auto / Bypass permissions | build / plan |
| set latency | 5–10 ms | 1–10 ms |

- **Options depend on the model.** Changing the model adds/removes options and their values;
  the answer to `set_config_option` is the truth, not what the client asked for.
- **The agents disagree on stickiness**: Claude Code keeps `effort=high` across a model
  switch, opencode resets effort to the new model's default. So order matters when re-applying
  settings (model first), and a value can simply stop existing.
- **Context size is not a separate option.** Claude Code models the 1M window as a model
  variant (`claude-fable-5-1[1m]`), and only lists `[1m]` variants the account can use. Setting
  an unlisted id (`opus[1m]`) is silently ignored — the model stays `opus`. So "context size"
  shows up as a model choice where the account offers one, not as its own control.
- **Settings don't survive the agent process.** A reloaded session comes back with the agent's
  defaults (Claude: its settings-file model; effort not kept), so canvas re-applies them.

## TanStack (`@tanstack/ai-acp`) cannot reach them

`acpCompatible` + `chat()` spawns the agent **per turn** and `startAcpSession` drops the
`session/new|load` response (so `configOptions` are never seen) and has no hook to call
`set_config_option`. Model selection there means a CLI flag in `command` — which neither
`claude-agent-acp` nor `opencode acp` has. The `openTransport` escape hatch could proxy the
JSON-RPC stream and inject calls before `session/prompt`, but settings would still only be
knowable while a turn runs, not when someone opens the picker.

## What canvas does now

`src/server/agents.ts` drives ACP with `@agentclientprotocol/sdk` directly and keeps **one
connection per session** while it is in use:

- the host's browser ensures a session for each agent frame once its agent is picked, which
  starts the agent (~0.8 s Claude, ~2 s opencode) so its options are there before the first
  prompt;
- `agent-config` → `set_config_option`; the reply (and any `config_option_update`) is
  broadcast as `agent-options` (live, not persisted) and summarised in `SessionMeta.settings`
  (persisted);
- the process stops after 15 min idle; reopening loads the session and re-applies
  `settings` model-first (`pendingChanges`, unit-tested);
- AG-UI chunks still come from `@tanstack/ai-acp`'s `translateAcpStream`, so the thread log and
  reducer are unchanged. `chat()`, `withSandbox` and the `.tanstack-projected-*` marker
  (finding 01) are gone from the server; follow-up turns no longer pay a process start.

## Validated (e2e `STEP=config`, host "Karl" + guest "Ada")

- Agent button → frame asks which agent → settings listed ~0.8–1.3 s later.
- Host picks Sonnet 5, then Effort High (the effort section appears after the model change);
  the guest's chip shows `Sonnet 5 · High`.
- Guest (edit access) picks Effort Low → host approval card "Ada wants to set Effort to Low"
  → applied; the next prompt answers "Claude Sonnet 5.".
- opencode: search "glm 5.3" in ~700 models → GLM-5.3 with its own effort list.
- `canvas serve` restart: chip shows `Sonnet 5 · Low` at once (from meta), live options follow
  ~1.4 s later, and the prompt still runs on Sonnet 5 (settings re-applied on load).

## Open

- Mode is shown like any option, so the host can switch Claude to *Bypass permissions*.
  A guest needs approval (edit) or trusted access for that, which matches ADR 0001, but a
  host may want to hide it.
- One agent process per open agent frame (Claude: `claude-agent-acp` + a `claude` child).
  Fine for a board; bounded only by the idle timeout.
- Options from a session that never connected since a restart show "starting agent…" until
  the host's browser brings it up; a start failure is reported as a room error.
