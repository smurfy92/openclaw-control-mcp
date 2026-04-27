import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildToolsCatalogTools(client: GatewayClient): ToolDef[] {
  const catalog: ToolDef = {
    name: "openclaw_tools_catalog",
    description:
      "List the catalog of agent-facing tools available to OpenClaw agents (i.e. what `main` and other agents can call from inside a session). Wraps `tools.catalog`. Read-only.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("tools.catalog", args ?? {}),
  };

  const effective: ToolDef = {
    name: "openclaw_tools_effective",
    description:
      "Get the effective (merged) tool set for an agent — base catalog + skill-provided + per-agent overrides. Wraps `tools.effective`. Read-only.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("tools.effective", args ?? {}),
  };

  return [catalog, effective];
}
