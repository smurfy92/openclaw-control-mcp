import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildModelsTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_models_list",
    description:
      "List models available to the gateway (Anthropic, OpenAI, etc.) with their IDs and any provider metadata. Wraps `models.list`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("models.list", {}),
  };

  return [list];
}
