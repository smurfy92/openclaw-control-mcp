import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

const idOnly = z.object({ id: z.string().min(1).describe("Session id") });

export function buildSessionsTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_sessions_list",
    description:
      "List active OpenClaw agentic sessions. Wraps `sessions.list`. Returns sessions with id, agent, status, last activity. Use to find a session id before patch/abort/compact/reset.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional(),
        status: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.list", args ?? {}),
  };

  const preview: ToolDef = {
    name: "openclaw_sessions_preview",
    description:
      "Preview one or more sessions without subscribing — returns recent messages, status, and metadata for each key. Wraps `sessions.preview`. Read-only. Pass `keys` (array of full session keys like 'agent:main:cron:<id>' from openclaw_sessions_list).",
    inputSchema: z
      .object({
        keys: z
          .array(z.string().min(1))
          .min(1)
          .describe("Full session keys (the `key` field returned by openclaw_sessions_list, NOT the sessionId UUID)"),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.preview", args ?? {}),
  };

  const create: ToolDef = {
    name: "openclaw_sessions_create",
    description:
      "Create a new agent session. Wraps `sessions.create`. Pass agentId, optional title, optional initial message; consult an existing session via openclaw_sessions_preview to learn the full param shape.",
    inputSchema: z
      .object({
        agentId: z.string().min(1).optional(),
        title: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.create", args ?? {}),
  };

  const patch: ToolDef = {
    name: "openclaw_sessions_patch",
    description:
      "Update session metadata (title, tags, etc.). Wraps `sessions.patch`. Pass id + the fields to update.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.patch", args ?? {}),
  };

  const send: ToolDef = {
    name: "openclaw_sessions_send",
    description:
      "Send a user message into an existing session. Wraps `sessions.send`. The agent will process and stream the reply via session.message events; use openclaw_sessions_preview afterwards to see the result.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Session id"),
        text: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.send", args ?? {}),
  };

  const abort: ToolDef = {
    name: "openclaw_sessions_abort",
    description:
      "Abort the in-flight agent turn for a session (cancels the current LLM call / tool loop). Wraps `sessions.abort`. Destructive — interrupts running work.",
    inputSchema: idOnly,
    handler: async (args) => client.request("sessions.abort", args ?? {}),
  };

  const reset: ToolDef = {
    name: "openclaw_sessions_reset",
    description:
      "Reset a session (clears working state, keeps session id). Wraps `sessions.reset`. Destructive — confirm before calling.",
    inputSchema: idOnly,
    handler: async (args) => client.request("sessions.reset", args ?? {}),
  };

  const remove: ToolDef = {
    name: "openclaw_sessions_delete",
    description:
      "Delete a session permanently. Wraps `sessions.delete`. Destructive — confirm before calling.",
    inputSchema: idOnly,
    handler: async (args) => client.request("sessions.delete", args ?? {}),
  };

  const compact: ToolDef = {
    name: "openclaw_sessions_compact",
    description:
      "Trigger a compaction of a session's history (creates a new compaction snapshot, keeps the session live). Wraps `sessions.compact`.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.compact", args ?? {}),
  };

  const compactionList: ToolDef = {
    name: "openclaw_sessions_compaction_list",
    description:
      "List compaction snapshots for a session. Wraps `sessions.compaction.list`. Read-only.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.compaction.list", args ?? {}),
  };

  const compactionGet: ToolDef = {
    name: "openclaw_sessions_compaction_get",
    description:
      "Fetch a specific compaction snapshot by id. Wraps `sessions.compaction.get`. Read-only.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Compaction snapshot id"),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.compaction.get", args ?? {}),
  };

  const compactionRestore: ToolDef = {
    name: "openclaw_sessions_compaction_restore",
    description:
      "Restore a session to a previous compaction snapshot. Wraps `sessions.compaction.restore`. Destructive — overwrites current session state.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Compaction snapshot id"),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.compaction.restore", args ?? {}),
  };

  const compactionBranch: ToolDef = {
    name: "openclaw_sessions_compaction_branch",
    description:
      "Branch off a new session from a previous compaction snapshot. Wraps `sessions.compaction.branch`.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Compaction snapshot id"),
        sessionId: z.string().optional(),
        title: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.compaction.branch", args ?? {}),
  };

  const subscribe: ToolDef = {
    name: "openclaw_sessions_subscribe",
    description:
      "Subscribe to session lifecycle events (sessions.changed). Wraps `sessions.subscribe`. Note: the MCP runs over stdio and cannot stream events back to the client — this tool registers the subscription server-side but you won't receive deltas in Claude Code. Useful mainly to confirm the subscription was accepted.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("sessions.subscribe", args ?? {}),
  };

  const unsubscribe: ToolDef = {
    name: "openclaw_sessions_unsubscribe",
    description: "Unsubscribe from session lifecycle events. Wraps `sessions.unsubscribe`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("sessions.unsubscribe", args ?? {}),
  };

  const messagesSubscribe: ToolDef = {
    name: "openclaw_sessions_messages_subscribe",
    description:
      "Subscribe to streaming session messages (session.message events). Wraps `sessions.messages.subscribe`. Note: MCP stdio cannot stream events to Claude Code — server-side subscription only.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.messages.subscribe", args ?? {}),
  };

  const messagesUnsubscribe: ToolDef = {
    name: "openclaw_sessions_messages_unsubscribe",
    description: "Unsubscribe from session message stream. Wraps `sessions.messages.unsubscribe`.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.messages.unsubscribe", args ?? {}),
  };

  return [
    list,
    preview,
    create,
    patch,
    send,
    abort,
    reset,
    remove,
    compact,
    compactionList,
    compactionGet,
    compactionRestore,
    compactionBranch,
    subscribe,
    unsubscribe,
    messagesSubscribe,
    messagesUnsubscribe,
  ];
}
