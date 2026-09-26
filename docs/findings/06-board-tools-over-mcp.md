# 06 — Giving agents board tools over MCP

Date: 2026-09-26 · Scripts: `spikes/07-board-mcp.ts`, `spikes/08-priming-keeps-prompt.ts`.
Versions: `@agentclientprotocol/sdk` 1.5.0, `@agentclientprotocol/claude-agent-acp` 0.81.2,
opencode 1.18.31.

## Question

Can an agent in an agent frame get canvas-specific tools (list the board, open frames, …), and
can canvas prime it about the board without the priming showing up in the thread?

## Tools: ACP passes MCP servers, the client picks them

`session/new` and `session/load` take `mcpServers` (canvas sends `[]` today). Each entry is
`stdio`, `http` or `sse`; `http`/`sse` need the agent's `mcpCapabilities`. There is also an
`acp` transport (MCP tunnelled over the ACP connection itself), marked **unstable** in the SDK
and advertised by neither agent. This is plain ACP, not a TanStack feature.

|                                          | Claude Code                                                               | opencode                                       |
| ---------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `mcpCapabilities`                        | `http`, `sse`                                                             | `http`, `sse`                                  |
| HTTP MCP server + `Authorization` header | works, header forwarded                                                   | works, header forwarded                        |
| tool name in the thread                  | `mcp__canvas__canvas`                                                     | `canvas_canvas`                                |
| permission asked for the MCP tool        | no, with `_meta.claudeCode.options.allowedTools: ["mcp__canvas__canvas"]` | no (opencode's default for MCP tools is allow) |
| tool loading                             | deferred: the model runs `ToolSearch` first, then calls                   | loaded up front                                |
| two tool calls, round trip               | ~14 s turn (Sonnet default)                                               | ~6 s turn                                      |

The spike's server is ~60 lines: stateless streamable HTTP, one JSON response per POST, `405`
for the GET (SSE) stream. Both clients were fine with that. The URL path can name the session
(`/mcp/<sessionId>`), so the server knows which agent frame is calling.

## Priming: MCP `instructions` reach both, and never enter the thread

Three hidden codewords, one per channel. Asked to quote every codeword it was given:

| channel                           | Claude Code                      | opencode                    |
| --------------------------------- | -------------------------------- | --------------------------- |
| MCP `initialize` → `instructions` | seen ("MCP Server Instructions") | seen                        |
| tool description                  | seen                             | seen                        |
| ACP `_meta.systemPrompt.append`   | seen ("appended system prompt")  | — (not an opencode feature) |

None of them appears in any ACP session update; the only way they reach a person is the model
repeating them. So **MCP server instructions are the agent-neutral system message**. Claude's
`systemPrompt.append` is an optional extra.

## Priming adds to the agent's own prompt; only a string system prompt replaces it

The worry: if priming replaced the agent's system prompt, the agent would lose what makes it a
coding agent. `claude-agent-acp` forwards `_meta.systemPrompt` to the Agent SDK. A **string**
replaces Claude Code's prompt; an **object** is forced to the `claude_code` preset, where
`append` adds to it (`sdk.d.ts`, `systemPrompt`). MCP `instructions` are a separate block the
agent adds by itself. There is no ACP field that replaces a prompt for any agent.

Spike 08 asks the same questions with no priming, MCP instructions, `append`, and a string
prompt as the control. Tool descriptions and injected context (working dir, date) survive even
a replacement, so asking "what are you, what rules do you follow" does not tell the variants
apart: the Bash tool description carries Claude's git rules. The discriminating probe
(`PROBE=opening`) asks for the system prompt's opening sentence and headings:

| Claude Code                     | opening                                                            | headings                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline                        | "You are a Claude agent, built on Anthropic's Claude Agent SDK. …" | System, Doing tasks, Executing actions with care, Using your tools, Tone and style, Text output, Session-specific guidance, Environment, Context management |
| MCP `instructions`              | same                                                               | same; the priming sits in a `# MCP Server Instructions` system-reminder block                                                                               |
| `systemPrompt.append`           | Claude Code's                                                      | same set; the priming sits in the MCP block too                                                                                                             |
| string `systemPrompt` (control) | the preamble, then the priming                                     | only Environment and MCP Server Instructions: **the prompt is gone**                                                                                        |

opencode refuses to quote its prompt, but describes the same contents (identity, tone guide,
tool rules, coding conventions) with and without the MCP server, plus "a note that I'm running
in an agent frame". Its answers to the default probe are the same with and without it: same
identity, same rules, one extra tool (`canvas_canvas`). opencode's ACP has no way to replace
its prompt at all.

So: **MCP `instructions` and Claude's `append` both keep the agent's prompt intact. Never send
a string `_meta.systemPrompt`.** One more thing from the SDK docs: Claude records the system
prompt on the first request and reuses it on resume (`snapshot`). Priming sent through
`append` should therefore be static; anything that changes (the frame's title, its
cluster) belongs in tool results.

## Consequences for canvas

- `canvas serve` can host the MCP endpoint on its own `Bun.serve`, one URL and secret per
  session, passed on both `newSession` and `loadSession`. The agent reaches it on `127.0.0.1`
  (or the `--tls-host` name, whose certificate is valid).
- Prime through MCP `instructions` (every agent). `append` is not needed, since Claude
  already shows the MCP block in its system context.
- The priming does not need to live in tool descriptions. That frees the tool design (one
  master tool or several) to follow other concerns. For Claude, each deferred tool costs a
  `ToolSearch` round trip unless the priming names the tools.
- The board is a Yjs doc in the host's browser, not on the server. A tool call has to be
  relayed to the host's browser (or the server has to become a Yjs peer).
