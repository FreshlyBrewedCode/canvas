/**
 * ACP session config options (`session/new` → `configOptions`,
 * `session/set_config_option`, `config_option_update`) mapped to canvas's
 * wire shape (finding 04). Agents decide which options exist — Claude Code
 * adds `effort` and `fast` only for models that support them, opencode lists
 * every model its providers offer — so nothing here knows specific ids.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentConfigValue,
  AgentSetting,
} from "../shared/protocol";
import { settingsOf, withSettings } from "../shared/agent-settings";

export { labelOf, settingsOf } from "../shared/agent-settings";

export function fromAcp(options: ReadonlyArray<SessionConfigOption>): AgentConfigOption[] {
  return options.map((option) => {
    const base = {
      id: option.id,
      name: option.name,
      ...(option.description && { description: option.description }),
      ...(option.category && { category: option.category }),
    };
    if (option.type === "boolean")
      return { ...base, type: "boolean", value: option.currentValue, choices: [] };
    const choices: AgentConfigChoice[] = [];
    for (const entry of option.options) {
      if ("group" in entry)
        for (const choice of entry.options)
          choices.push({ ...choiceOf(choice), group: entry.name });
      else choices.push(choiceOf(entry));
    }
    return { ...base, type: "select", value: option.currentValue, choices };
  });
}

const choiceOf = (choice: { value: string; name: string; description?: string | null }) => ({
  value: choice.value,
  name: choice.name,
  ...(choice.description && { description: choice.description }),
});

/**
 * What a new session will start with, before its agent runs (ADR 0012): the
 * settings its kind offered last, with the values asked for where offered.
 */
export function seededSettings(
  options: ReadonlyArray<AgentConfigOption>,
  wanted: ReadonlyArray<Pick<AgentSetting, "id" | "value">> = [],
): AgentSetting[] {
  return settingsOf(withSettings(options, wanted));
}

/**
 * Which of the wanted settings still differ from what the agent reports, in
 * the order to apply them: the model first, since it decides which other
 * options exist and what they accept. Values an option does not offer (any
 * more) are skipped rather than sent.
 */
export function pendingChanges(
  options: ReadonlyArray<AgentConfigOption>,
  wanted: ReadonlyArray<Pick<AgentSetting, "id" | "value">>,
): Array<{ id: string; value: AgentConfigValue }> {
  const byId = new Map(options.map((option) => [option.id, option]));
  return wanted
    .filter(({ id, value }) => {
      const option = byId.get(id);
      if (!option || option.value === value) return false;
      return option.type === "boolean"
        ? typeof value === "boolean"
        : option.choices.some((choice) => choice.value === value);
    })
    .map(({ id, value }) => ({ id, value }))
    .sort((a, b) => rank(byId.get(a.id)!) - rank(byId.get(b.id)!));
}

const rank = (option: AgentConfigOption) => (option.category === "model" ? 0 : 1);
