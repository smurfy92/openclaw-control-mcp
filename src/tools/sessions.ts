import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

const TERMINAL_STATUSES = new Set(["done", "error", "aborted", "timeout", "completed"]);

function extractMessages(previewResult: unknown, key: string): unknown[] {
  if (!previewResult || typeof previewResult !== "object") return [];
  const r = previewResult as Record<string, unknown>;
  const direct = (r[key] as Record<string, unknown> | undefined)?.messages;
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(r.messages)) return r.messages;
  const previews = r.previews as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(previews) && Array.isArray(previews[0]?.messages)) return previews[0].messages as unknown[];
  const sessions = r.sessions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(sessions) && Array.isArray(sessions[0]?.messages)) return sessions[0].messages as unknown[];
  return [];
}

function extractStatus(previewResult: unknown, key: string): string | null {
  if (!previewResult || typeof previewResult !== "object") return null;
  const r = previewResult as Record<string, unknown>;
  const direct = (r[key] as Record<string, unknown> | undefined)?.status;
  if (typeof direct === "string") return direct;
  if (typeof r.status === "string") return r.status;
  const previews = r.previews as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(previews) && typeof previews[0]?.status === "string") return previews[0].status as string;
  return null;
}

function messageId(m: unknown): string {
  if (m && typeof m === "object") {
    const o = m as Record<string, unknown>;
    if (typeof o.id === "string" || typeof o.id === "number") return String(o.id);
    const role = typeof o.role === "string" ? o.role : "?";
    const ts = typeof o.createdAtMs === "number" ? o.createdAtMs : (typeof o.timestamp === "number" ? o.timestamp : "?");
    const text = typeof o.content === "string" ? o.content.slice(0, 64) : (typeof o.text === "string" ? o.text.slice(0, 64) : "");
    return `${role}:${ts}:${text}`;
  }
  return String(m);
}

const idOnly = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Session id. Most session.* methods accept the `sessionId` (UUID); a few accept the composite `key` (e.g. 'agent:main:cron:<id>'). When unsure, try the UUID first; if rejected with NOT_FOUND, retry with the key from openclaw_sessions_list.",
    ),
});

export function buildSessionsTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_sessions_list",
    description:
      "List active OpenClaw agentic sessions. Wraps `sessions.list`. Each session has both a `sessionId` (UUID) and a `key` (composite, e.g. 'agent:main:main', 'agent:main:cron:<id>', 'agent:main:telegram:group:<chat-id>', 'agent:main:subagent:<uuid>'). Use to find a session before preview/patch/abort/compact/reset.",
    inputSchema: z
      .object({
        agentId: z.string().optional().describe("Filter by agent id (e.g. 'main')."),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional(),
        status: z
          .string()
          .optional()
          .describe(
            "Filter by status. Observed values: 'running' (in-flight agent turn), 'done' (completed). May also include 'error' / 'aborted' / 'timeout' depending on gateway version.",
          ),
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
      "Create a new agent session. Wraps `sessions.create`. The default agent id is typically 'main'. Pass an optional `title` to set the human-readable label shown in the Control panel.",
    inputSchema: z
      .object({
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Agent id (e.g. 'main'). Defaults to the gateway's default agent if omitted."),
        title: z.string().optional().describe("Human-readable title shown in the Control panel."),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.create", args ?? {}),
  };

  const patch: ToolDef = {
    name: "openclaw_sessions_patch",
    description:
      "Update session metadata (title, displayName, tags, etc.). Wraps `sessions.patch`. Pass id + only the fields you want to change. Schema is intentionally permissive — gateway accepts any subset of session fields.",
    inputSchema: idOnly.passthrough(),
    handler: async (args) => client.request("sessions.patch", args ?? {}),
  };

  const send: ToolDef = {
    name: "openclaw_sessions_send",
    description:
      "Send a user message into an existing session. Wraps `sessions.send`. The agent processes async and streams the reply via session.message events; call openclaw_sessions_preview afterwards (with the session's composite key) to see the result. Use either `text` or `message` — gateway accepts both names depending on version.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Session id (sessionId UUID)."),
        text: z.string().optional().describe("Message text. Preferred field name in newer gateway versions."),
        message: z.string().optional().describe("Message text. Older alias for `text`; pass either, not both."),
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
        id: z.string().min(1).describe("Compaction snapshot id (NOT the session id — get this from openclaw_sessions_compaction_list)."),
        sessionId: z.string().optional().describe("Optional session id, helps disambiguate when the snapshot id is shared across sessions."),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.compaction.get", args ?? {}),
  };

  const compactionRestore: ToolDef = {
    name: "openclaw_sessions_compaction_restore",
    description:
      "Restore a session to a previous compaction snapshot. Wraps `sessions.compaction.restore`. Destructive — overwrites current session state with the snapshot. The current state is lost unless you branched first.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Compaction snapshot id."),
        sessionId: z.string().optional().describe("Optional session id; required when the snapshot id is ambiguous."),
      })
      .passthrough(),
    handler: async (args) => client.request("sessions.compaction.restore", args ?? {}),
  };

  const compactionBranch: ToolDef = {
    name: "openclaw_sessions_compaction_branch",
    description:
      "Create a NEW session that starts from a previous compaction snapshot of an existing session. Wraps `sessions.compaction.branch`. Use this when you want to explore an alternative continuation without losing the current session state.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Compaction snapshot id to branch from."),
        sessionId: z.string().optional().describe("Source session id, when the snapshot id is ambiguous."),
        title: z.string().optional().describe("Title for the new branched session."),
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

  const tail: ToolDef = {
    name: "openclaw_sessions_tail",
    description:
      "Watch a session by polling `sessions.preview` and return only the NEW messages that appeared during the tail window. Workaround for the stdio MCP not being able to stream `sessions.subscribe` / `session.message` events to Claude Code. Polls every `intervalMs` (default 2000ms) for up to `durationMs` (default 30000ms, max 300000ms), or until `maxMessages` new messages are collected, or until the session reaches a terminal status ('done', 'error', 'aborted', 'timeout', 'completed'). The first poll seeds the 'already-seen' set so existing messages are NOT returned — only what arrives after the tool was called.",
    inputSchema: z
      .object({
        key: z
          .string()
          .min(1)
          .describe("Full session key (composite, e.g. 'agent:main:cron:<id>') from openclaw_sessions_list."),
        durationMs: z
          .number()
          .int()
          .min(1000)
          .max(300_000)
          .default(30_000)
          .describe("Total tail duration in ms. Default 30000 (30s). Max 300000 (5min)."),
        intervalMs: z
          .number()
          .int()
          .min(500)
          .max(10_000)
          .default(2_000)
          .describe("Polling interval in ms. Default 2000 (2s). Min 500 to avoid hammering the gateway. Max 10000."),
        maxMessages: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Stop early once this many new messages have arrived — useful to bail out on the first agent reply."),
      })
      .passthrough(),
    handler: async (args) => {
      const { key, durationMs, intervalMs, maxMessages } = args as {
        key: string;
        durationMs: number;
        intervalMs: number;
        maxMessages?: number;
      };

      const seenIds = new Set<string>();
      const newMessages: unknown[] = [];
      const start = Date.now();
      const deadline = start + durationMs;
      let polls = 0;
      let lastStatus: string | null = null;
      let stoppedReason: "duration" | "maxMessages" | "sessionDone" = "duration";

      polls++;
      const initialPreview = await client.request("sessions.preview", { keys: [key] });
      for (const m of extractMessages(initialPreview, key)) seenIds.add(messageId(m));
      lastStatus = extractStatus(initialPreview, key);

      if (lastStatus && TERMINAL_STATUSES.has(lastStatus)) {
        return {
          key,
          durationMs: Date.now() - start,
          polls,
          newMessages,
          lastStatus,
          stoppedReason: "sessionDone" as const,
        };
      }

      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const sleepMs = Math.min(intervalMs, remaining);
        if (sleepMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, sleepMs));

        polls++;
        const preview = await client.request("sessions.preview", { keys: [key] });
        lastStatus = extractStatus(preview, key);
        for (const m of extractMessages(preview, key)) {
          const id = messageId(m);
          if (!seenIds.has(id)) {
            seenIds.add(id);
            newMessages.push(m);
          }
        }

        if (maxMessages !== undefined && newMessages.length >= maxMessages) {
          stoppedReason = "maxMessages";
          break;
        }
        if (lastStatus && TERMINAL_STATUSES.has(lastStatus)) {
          stoppedReason = "sessionDone";
          break;
        }
      }

      return {
        key,
        durationMs: Date.now() - start,
        polls,
        newMessages,
        lastStatus,
        stoppedReason,
      };
    },
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
    tail,
  ];
}
