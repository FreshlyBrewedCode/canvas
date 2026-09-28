# 03 — Prototype validation: does the concept hold?

Date: 2026-09-25. Driven by `e2e/drive.ts` (two isolated Chromium contexts, "Karl" as host
and "Ada" as guest) against `vite` on `https://dev.example.ts.net:4417` and
`canvas serve --tls-host dev.example.ts.net` on a scratch repo.

## What was shown working

| | result |
|---|---|
| CLI prints a host link → browser connects to `canvas serve` over wss | yes |
| guest joins via the copied guest link, verifies the host's signature | yes, ~1–2 s via Nostr relays |
| frames created by one peer appear for the other; drag/resize synced | yes |
| two people typing into the same prompt draft, each seeing the other's caret | yes (y-codemirror) |
| live pointers with names | yes |
| guest's text selection in an agent thread shown on the host, in the guest's colour | yes |
| guest presses send → host gets an approval card → runs on host's machine | yes |
| agent tool-call permission (e.g. `ls`, `mkdir`, Claude's `Edit`) → host-only buttons, guest sees "waiting for the host" | yes, placed under the tool call it gates |
| opencode and Claude Code through the same generic ACP adapter | yes |
| markdown artifact bound to a file the agent writes, updates live for everyone | yes |
| terminal on the host, output mirrored to the guest; guest typing refused under `edit` | yes |
| board, sessions and room survive a `canvas serve` restart (same link) | yes |

## Rough edges seen (not blockers)

- **Permission fatigue.** opencode is configured with `bash: "ask"`, and it asks for every
  `ls`/`mkdir`/`git status`. Good for demonstrating the model, tedious in use — a per-session
  "allow always" (ACP `allow_always`, which the card already offers) or an allowlist is needed.
  *Later:* canvas no longer sets a permission policy for opencode. Its defaults (everything
  allowed, `external_directory` and `doom_loop` ask) and the host's `opencode.json` decide; the
  inline config outranked the host's own rules. Checked over ACP with opencode 1.18.31: `ls` runs,
  `cat /etc/hostname` asks.
- **Host must be online.** Everything flows through the host's browser (ADR 0001).
- **Browser frames load per viewer.** The URL is shared, the page is not — `localhost:3000`
  means each viewer's own machine. Sharing the host's dev server with guests would need a
  proxy over the data channel.
- **Terminals don't survive a server restart** (the PTY dies; the frame starts a new shell).
- **Late joiners get the whole session log** in one trystero message; fine at prototype scale,
  will need paging for long sessions.
- Agent turns spawn a fresh agent process per prompt (`chat()` per turn + ACP `loadSession`);
  Claude's first turn takes ~20 s cold.
- Nostr relays in trystero's default list are sometimes down (502s in the console); discovery
  still worked via the others every time.
