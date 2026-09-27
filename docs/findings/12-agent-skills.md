# 12 — Agent skills shipped with canvas

Date: 2026-09-27 · Scripts: `spikes/09-skills.ts`, `spikes/10-skill-priming.ts`.
Versions: `@agentclientprotocol/claude-agent-acp` 0.81.2 (Agent SDK 0.3.280), opencode 1.18.31.

## Question

Can canvas give every agent session its own skills, from outside the project and the host's
config, so nobody installs them? And over ACP, or only over MCP?

## Both agents take a skills folder at launch

ACP has no skills field, but both agents already take per-session configuration canvas sends:

|                  | Claude Code                                                                | opencode                                              |
| ---------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| how              | `_meta.claudeCode.options.plugins: [{ type: "local", path }]` on `session/new` / `session/load`, spread into the Agent SDK's options | `skills.paths` in `OPENCODE_CONFIG_CONTENT`           |
| what `path` is   | a plugin: `.claude-plugin/plugin.json`, skills under it                    | a folder of `<name>/SKILL.md`                         |
| name in listing  | `canvas:code-tour` (alias `code-tour`)                                      | `code-tour`                                           |
| host's skills    | still listed beside it                                                     | still listed beside it                                |
| permission asked | no                                                                         | no                                                    |

Spike 09's skill holds a codeword only its body knows. With the folder passed, both agents
loaded the skill (`Load skill` / `skill`) and quoted the codeword; without it (control) neither
knew it.

One folder serves both: a plugin manifest may point `skills` at a path, and `"skills": "./"`
makes the plugin root itself the skills folder. So `skills/` holds `.claude-plugin/plugin.json`
and one folder per skill; opencode reads the same folder and passes over the manifest, which is
no `SKILL.md`. `skipMcpDiscovery: true` keeps Claude from looking for an `.mcp.json` there.

claude-agent-acp counts `plugins` among the options that rebuild a session on `session/load`;
canvas sends the same `_meta` on load, so a resumed session keeps the skills.

MCP has no skill primitive. MCP prompts reach both agents, but as slash commands for people, not
something the model picks up by itself. Rebuilding skills as instructions plus a tool is possible
but only worth it for an agent without native skills.

## Claude drops the descriptions when the host has many skills

On this machine (~50 of the host's own skills), Claude listed `canvas:code-tour` **by name
only**; the Agent SDK's `supportedCommands()` has the description, and with `settingSources: []`
(host skills off) the listing shows it. The listing has a budget, and canvas's plugin skill was
among those cut to a name, while the host's `tdd` kept its description. The model then has only
the name to go on.

So the board priming (MCP `instructions`, finding 06) names canvas's skills too, generated from
`skills/`: one line per skill, its name and description, and "load it with your skill tool
before you start". Spike 10, asked _"Give us a code tour of how login works here."_ in a two-file
repo, with the host's skills present:

| agent                                 | loaded `code-tour` | board calls                                                           |
| ------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| opencode                              | 1 of 1, first call | one `open_frame` with a list: `0 Guide.md`, then the stops at lines   |
| Claude Code (Haiku, the host default) | 2 of 3             | when loaded, the guide via `write_board_file`, then one `open_frame`; the miss opened a frame per file |

## Consequences for canvas

- `skills/` at the repo root ships in the package (`scripts/build-release.ts`) and is resolved
  beside `src/` (`src/server/skills.ts`), so a checkout and an install both find it.
- A skill is a folder with a `SKILL.md` whose `name` is the folder's name; `skills.test.ts`
  holds that, since an agent drops an unreadable skill silently.
- A skill's description is also priming: keep it short, and put its trigger in it.
