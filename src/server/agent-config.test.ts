import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { fromAcp, pendingChanges, settingsOf } from "./agent-config";

// Shapes as Claude Code (via claude-agent-acp) and opencode report them.
const acp: SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Manual" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "haiku",
    options: [
      { group: "anthropic", name: "Anthropic", options: [{ value: "haiku", name: "Haiku 4.5" }] },
      { group: "other", name: "Other", options: [{ value: "glm", name: "GLM" }] },
    ],
  },
  { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
];

test("flattens grouped choices and keeps booleans", () => {
  const options = fromAcp(acp);
  expect(options.find((o) => o.id === "model")!.choices).toEqual([
    { value: "haiku", name: "Haiku 4.5", group: "Anthropic" },
    { value: "glm", name: "GLM", group: "Other" },
  ]);
  expect(options.find((o) => o.id === "fast")).toMatchObject({
    type: "boolean",
    value: false,
    choices: [],
  });
});

test("settings carry display labels", () => {
  expect(settingsOf(fromAcp(acp)).map((s) => `${s.id}=${s.label}`)).toEqual([
    "mode=Manual",
    "effort=Default",
    "model=Haiku 4.5",
    "fast=off",
  ]);
});

test("pending changes put the model first and skip what cannot apply", () => {
  const changes = pendingChanges(fromAcp(acp), [
    { id: "effort", value: "high" },
    { id: "mode", value: "default" }, // already so
    { id: "model", value: "glm" },
    { id: "fast", value: "yes" }, // wrong type
    { id: "gone", value: "x" }, // no such option
    { id: "effort", value: "turbo" }, // not offered
  ]);
  expect(changes).toEqual([
    { id: "model", value: "glm" },
    { id: "effort", value: "high" },
  ]);
});
