import { describe, expect, test } from "bun:test";

import { todoPlan } from "./todo-plan";

describe("todoPlan", () => {
  test("opencode's todowrite input is a plan", () => {
    expect(
      todoPlan({
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        status: "in_progress",
        rawInput: {
          title: "todowrite",
          todos: [
            { content: "look around", status: "in_progress", priority: "high" },
            { content: "think", status: "pending" },
          ],
        },
      }),
    ).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "look around", status: "in_progress", priority: "high" },
        { content: "think", status: "pending", priority: "medium" },
      ],
    });
  });

  test("other tool calls and malformed todos are not", () => {
    expect(
      todoPlan({
        sessionUpdate: "tool_call",
        toolCallId: "c",
        title: "read",
        rawInput: { path: "a" },
      }),
    ).toBeNull();
    expect(
      todoPlan({
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        rawInput: { todos: [{ content: "x", status: "cancelled" }, "y"] },
      }),
    ).toBeNull();
    expect(
      todoPlan({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      }),
    ).toBeNull();
  });
});
