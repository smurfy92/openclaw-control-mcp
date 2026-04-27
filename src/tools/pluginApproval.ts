import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildPluginApprovalTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_plugin_approval_list",
    description:
      "List pending and recent plugin approval requests (a skill / plugin asking for permission to do X). Wraps `plugin.approval.list`. Read-only.",
    inputSchema: z
      .object({
        status: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("plugin.approval.list", args ?? {}),
  };

  const request: ToolDef = {
    name: "openclaw_plugin_approval_request",
    description:
      "Submit a plugin approval request (programmatic). Wraps `plugin.approval.request`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("plugin.approval.request", args ?? {}),
  };

  const resolve: ToolDef = {
    name: "openclaw_plugin_approval_resolve",
    description:
      "Resolve a pending plugin approval (approve / reject). Wraps `plugin.approval.resolve`. Mutates.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Plugin approval request id"),
        decision: z.enum(["approve", "reject", "deny"]).optional(),
        approved: z.boolean().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("plugin.approval.resolve", args ?? {}),
  };

  const waitDecision: ToolDef = {
    name: "openclaw_plugin_approval_waitDecision",
    description:
      "Block until a plugin approval gets a decision. Wraps `plugin.approval.waitDecision`. Long-running.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Plugin approval request id"),
        timeoutMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("plugin.approval.waitDecision", args ?? {}),
  };

  return [list, request, resolve, waitDecision];
}
