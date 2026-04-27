import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildChatTools(client: GatewayClient): ToolDef[] {
  const send: ToolDef = {
    name: "openclaw_chat_send",
    description:
      "Send a chat message via the gateway's native chat method. Wraps `chat.send`. This is the management-plane equivalent of the upstream `openclaw-mcp` chat (which 404s on this gateway). Pass agentId/sessionId/text; consult openclaw_chat_history for the param shape used by your gateway.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
        text: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("chat.send", args ?? {}),
  };

  const history: ToolDef = {
    name: "openclaw_chat_history",
    description:
      "Fetch chat history for an agent or session. Wraps `chat.history`. Read-only.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("chat.history", args ?? {}),
  };

  const abort: ToolDef = {
    name: "openclaw_chat_abort",
    description:
      "Abort an in-flight chat turn. Wraps `chat.abort`. Destructive — cancels running LLM call.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("chat.abort", args ?? {}),
  };

  return [send, history, abort];
}
