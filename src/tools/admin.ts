import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildAdminTools(client: GatewayClient): ToolDef[] {
  const updateRun: ToolDef = {
    name: "openclaw_update_run",
    description:
      "Trigger an update of the gateway itself (pull latest version, restart components). Wraps `update.run`. DESTRUCTIVE — may briefly interrupt running sessions. Confirm before calling.",
    inputSchema: z
      .object({
        version: z.string().optional().describe("Specific version to install; omit for latest"),
      })
      .passthrough(),
    handler: async (args) => client.request("update.run", args ?? {}),
  };

  const commandsList: ToolDef = {
    name: "openclaw_commands_list",
    description:
      "List the slash-commands registered in the gateway (commands the agent or operator can invoke). Wraps `commands.list`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("commands.list", {}),
  };

  const messageAction: ToolDef = {
    name: "openclaw_message_action",
    description:
      "Trigger a message-level action (e.g. retry, mark-as-handled, attach to a session). Wraps `message.action`. Mutates gateway state.",
    inputSchema: z
      .object({
        action: z.string().min(1).describe("Action name"),
        messageId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("message.action", args ?? {}),
  };

  return [updateRun, commandsList, messageAction];
}
