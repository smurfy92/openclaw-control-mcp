import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildLogsTools(client: GatewayClient): ToolDef[] {
  const tail: ToolDef = {
    name: "openclaw_logs_tail",
    description:
      "Tail recent gateway logs. Wraps `logs.tail`. Read-only. Pass `limit` to bound the response (default whatever the gateway picks). Use this for debug — e.g. tracing why a cron job failed, why a session aborted, or what an agent emitted.",
    inputSchema: z
      .object({
        limit: z.number().int().positive().max(2000).optional(),
        sinceMs: z.number().int().positive().optional().describe("Only return logs newer than this epoch ms"),
        level: z.string().optional().describe("Filter by log level (info/warn/error)"),
        component: z.string().optional().describe("Filter by component/source"),
      })
      .passthrough(),
    handler: async (args) => client.request("logs.tail", args ?? {}),
  };

  return [tail];
}
