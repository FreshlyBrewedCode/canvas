/**
 * An agent's settings as values (`AgentSetting`), from the options it lists
 * (`AgentConfigOption`): what is shown and kept while no agent runs. Shared:
 * `canvas serve` keeps them in a session's meta, browsers show a kind's
 * before any session of it began (ADR 0012).
 */

import type { AgentConfigOption, AgentConfigValue, AgentSetting } from "./protocol";

export function settingsOf(options: ReadonlyArray<AgentConfigOption>): AgentSetting[] {
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    ...(option.category && { category: option.category }),
    value: option.value,
    label: labelOf(option, option.value),
  }));
}

export function labelOf(option: AgentConfigOption, value: AgentConfigValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return option.choices.find((choice) => choice.value === value)?.name ?? value;
}

/** Options with the values of `settings` where they offer them: a session's, shown before its agent runs. */
export function withSettings(
  options: ReadonlyArray<AgentConfigOption>,
  settings: ReadonlyArray<Pick<AgentSetting, "id" | "value">> = [],
): AgentConfigOption[] {
  const values = new Map(settings.map(({ id, value }) => [id, value]));
  return options.map((option) => {
    const value = values.get(option.id);
    const offered =
      value !== undefined &&
      (option.type === "boolean"
        ? typeof value === "boolean"
        : option.choices.some((choice) => choice.value === value));
    return offered ? { ...option, value } : option;
  });
}
