#!/usr/bin/env bun
/**
 * A stand-in ACP agent for `agents.test.ts`: it offers a model and an effort,
 * answers every prompt with "ok", and writes each call it gets to
 * `FAKE_ACP_LOG`, one JSON line each, with its process id. `FAKE_ACP_CAPS`
 * (JSON) are its `sessionCapabilities`; `loadSession` it always offers.
 */
import { appendFileSync } from "node:fs";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const log = (method: string, params: unknown) =>
  appendFileSync(
    process.env.FAKE_ACP_LOG!,
    `${JSON.stringify({ pid: process.pid, method, params })}\n`,
  );
const capabilities = JSON.parse(process.env.FAKE_ACP_CAPS ?? "{}") as Record<string, object>;

const settings = new Map<string, Record<string, string>>();
const optionsOf = (sessionId: string): SessionConfigOption[] => {
  const values = settings.get(sessionId) ?? { model: "small", effort: "low" };
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: values.model!,
      options: [
        { value: "small", name: "Small" },
        { value: "large", name: "Large" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: values.effort!,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
};

let next = 0;
const connection = new AgentSideConnection(
  (client) => ({
    initialize: (params) => {
      log("initialize", params);
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: capabilities },
      };
    },
    authenticate: () => ({}),
    newSession: (params) => {
      const sessionId = `acp-${process.pid}-${next++}`;
      log("session/new", { ...params, sessionId });
      return { sessionId, configOptions: optionsOf(sessionId) };
    },
    loadSession: (params) => {
      log("session/load", params);
      return { configOptions: optionsOf(params.sessionId) };
    },
    resumeSession: (params) => {
      log("session/resume", params);
      return { configOptions: optionsOf(params.sessionId) };
    },
    closeSession: (params) => {
      log("session/close", params);
      return {};
    },
    setSessionConfigOption: (params) => {
      log("session/set_config_option", params);
      const values = { model: "small", effort: "low", ...settings.get(params.sessionId) };
      settings.set(params.sessionId, { ...values, [params.configId]: String(params.value) });
      return { configOptions: optionsOf(params.sessionId) };
    },
    prompt: async (params) => {
      log("session/prompt", params);
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      });
      return { stopReason: "end_turn" };
    },
    cancel: (params) => log("session/cancel", params),
  }),
  ndJsonStream(
    new WritableStream<Uint8Array>({ write: (chunk) => void process.stdout.write(chunk) }),
    Bun.stdin.stream(),
  ),
);
await connection.closed;
