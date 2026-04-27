import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildWizardTools(client: GatewayClient): ToolDef[] {
  const start: ToolDef = {
    name: "openclaw_wizard_start",
    description:
      "Start a setup wizard flow (e.g. agent onboarding, channel pairing). Wraps `wizard.start`. Pass the wizard id / kind.",
    inputSchema: z
      .object({
        kind: z.string().optional(),
        id: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("wizard.start", args ?? {}),
  };

  const next: ToolDef = {
    name: "openclaw_wizard_next",
    description:
      "Advance the active wizard to its next step (with the user's answer to the current step). Wraps `wizard.next`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("wizard.next", args ?? {}),
  };

  const cancel: ToolDef = {
    name: "openclaw_wizard_cancel",
    description:
      "Cancel the active wizard flow without applying its changes. Wraps `wizard.cancel`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("wizard.cancel", args ?? {}),
  };

  const status: ToolDef = {
    name: "openclaw_wizard_status",
    description:
      "Get the active wizard's current step and pending input. Wraps `wizard.status`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("wizard.status", {}),
  };

  return [start, next, cancel, status];
}
