import { describe, expect, test } from "bun:test";

import type { AgentConfigOption } from "../../shared/protocol";
import { modeOption, modeTone, nextMode } from "./agent-mode";

const claude = (value: string): AgentConfigOption => ({
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  value,
  choices: [
    { value: "default", name: "Manual" },
    { value: "acceptEdits", name: "Accept edits" },
    { value: "plan", name: "Plan" },
    { value: "auto", name: "Auto" },
    { value: "bypassPermissions", name: "Bypass permissions" },
  ],
});

describe("agent mode", () => {
  test("found by its category", () => {
    const model: AgentConfigOption = { ...claude("x"), id: "model", category: "model" };
    expect(modeOption([model, claude("plan")])?.id).toBe("mode");
    expect(modeOption([model])).toBeUndefined();
    expect(modeOption(undefined)).toBeUndefined();
  });

  test("cycling goes round, passing over bypassing permissions", () => {
    expect(nextMode(claude("default"))).toBe("acceptEdits");
    expect(nextMode(claude("plan"))).toBe("auto");
    expect(nextMode(claude("auto"))).toBe("default");
    // From an unguarded mode, back to the start.
    expect(nextMode(claude("bypassPermissions"))).toBe("default");
  });

  test("modes the agent refused are passed over", () => {
    expect(nextMode(claude("plan"), new Set(["auto"]))).toBe("default");
    expect(nextMode(claude("acceptEdits"), new Set(["auto"]))).toBe("plan");
  });

  test("nothing to cycle through with one mode", () => {
    const one = { ...claude("default"), choices: [{ value: "default", name: "Manual" }] };
    expect(nextMode(one)).toBeNull();
  });

  test("tones: the default is quiet, plan and unguarded stand out", () => {
    expect(modeTone(claude("default"))).toBe("default");
    expect(modeTone(claude("plan"))).toBe("plan");
    expect(modeTone(claude("bypassPermissions"))).toBe("risky");
    expect(modeTone(claude("acceptEdits"))).toBe("other");
  });
});
