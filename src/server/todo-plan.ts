/**
 * Agents that keep a todo list without sending ACP `plan` updates (opencode's
 * `todowrite`) still have a plan: the list, in the tool call's input. This
 * reads it as the plan update the agent would have sent, so a thread knows
 * one kind of plan only.
 */

import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function todoPlan(update: SessionUpdate): SessionUpdate | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
    return null;
  const input = update.rawInput as { todos?: unknown } | null | undefined;
  if (!Array.isArray(input?.todos)) return null;
  const entries = input.todos.flatMap((todo: unknown): PlanEntry[] => {
    const { content, status, priority } = (todo ?? {}) as Record<string, unknown>;
    if (typeof content !== "string" || typeof status !== "string" || !STATUSES.has(status))
      return [];
    return [
      {
        content,
        status: status as PlanEntry["status"],
        priority: priority === "high" || priority === "low" ? priority : "medium",
      },
    ];
  });
  return entries.length ? { sessionUpdate: "plan", entries } : null;
}
