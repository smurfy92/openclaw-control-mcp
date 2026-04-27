import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildUsageTools(client: GatewayClient): ToolDef[] {
  const status: ToolDef = {
    name: "openclaw_usage_status",
    description:
      "Get usage status (token counts, current period, quotas). Wraps `usage.status`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("usage.status", {}),
  };

  const cost: ToolDef = {
    name: "openclaw_usage_cost",
    description:
      "Get usage cost breakdown (per agent, per model, per period). Wraps `usage.cost`. Read-only. Pass period/agent filters if supported.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sinceMs: z.number().int().positive().optional(),
        untilMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("usage.cost", args ?? {}),
  };

  return [status, cost];
}
