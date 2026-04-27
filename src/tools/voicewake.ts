import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildVoicewakeTools(client: GatewayClient): ToolDef[] {
  const get: ToolDef = {
    name: "openclaw_voicewake_get",
    description:
      "Get the voice-wake configuration (wake word, sensitivity, enabled). Wraps `voicewake.get`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("voicewake.get", {}),
  };

  const set: ToolDef = {
    name: "openclaw_voicewake_set",
    description:
      "Update the voice-wake configuration. Wraps `voicewake.set`.",
    inputSchema: z
      .object({
        enabled: z.boolean().optional(),
        wakeWord: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("voicewake.set", args ?? {}),
  };

  return [get, set];
}
