---
title: Skills
description: The agent skills canvas gives every agent session.
section: Features
order: 9
---

canvas comes with **skills**: instructions an agent loads when a request calls for them, for
work on the board. Every agent session canvas starts has them, Claude Code and opencode alike.

**You don't install them.** `canvas serve` hands its skills to each agent it launches, so a new
canvas release brings its skills with it. Nothing is copied into your project or your agent's
config, and your own skills stay available beside them.

| Skill       | For                                                                        |
| ----------- | -------------------------------------------------------------------------- |
| `code-tour` | A guided walk through how part of the code works, as one files frame       |

## Code tour

Ask an agent for a tour: _"Give us a code tour of how login works"_, _"walk me through the
checkout flow"_. It opens one files frame whose [list](/docs/files#lists) is the tour:

1. a guide, a [scratch file](/docs/board-tools#scratch-files) with one short section per stop;
2. the **stops**: the files that tell the story, in reading order, each at the lines that matter;
3. for flows that branch, a diagram at the end.

Everyone clicks through it at their own pace. Ask the agent to _walk you through it_ and it moves
the frame from stop to stop, and everyone [following](/docs/focus) the agent scrolls with it.
Follow-up questions can add stops or rewrite the guide, in the same frame.

## How agents pick them

An agent loads a skill when your request matches what the skill is for, like any skill of its
own. You can also name it: _"use the code-tour skill"_. Claude Code lists them as
`canvas:code-tour`, opencode as `code-tour`.

The skills exist only in sessions canvas starts. The same agent, run in a terminal outside
canvas, doesn't have them, and couldn't use them without the board anyway.
