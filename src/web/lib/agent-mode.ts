/**
 * The agent's mode (the session config option of category `mode`): Claude
 * Code's Manual / Accept edits / Plan / Auto / Bypass permissions, opencode's
 * build / plan. The agent lists its default first.
 */

import type { AgentConfigOption } from "../../shared/protocol";

export type ModeTone = "default" | "plan" | "risky" | "other";

export const modeOption = (options: ReadonlyArray<AgentConfigOption> | undefined) =>
  options?.find((option) => option.category === "mode" && option.type === "select");

/** Modes that let the agent act without asking: never reached by cycling. */
const UNGUARDED = /bypass|yolo|dangerous/i;

export function modeTone(option: AgentConfigOption, value = option.value): ModeTone {
  if (value === option.choices[0]?.value) return "default";
  if (typeof value === "string" && UNGUARDED.test(value)) return "risky";
  if (typeof value === "string" && /plan/i.test(value)) return "plan";
  return "other";
}

/**
 * The mode after the current one, round the list, passing over unguarded
 * ones and those the agent refused (`skip`: Claude Code's Auto, on models
 * without it).
 */
export function nextMode(
  option: AgentConfigOption,
  skip: ReadonlySet<string> = new Set(),
): string | null {
  const safe = option.choices.filter(
    (choice) =>
      !UNGUARDED.test(choice.value) && (!skip.has(choice.value) || choice.value === option.value),
  );
  if (safe.length < 2) return null;
  const at = safe.findIndex((choice) => choice.value === option.value);
  return safe[(at + 1) % safe.length]!.value;
}
