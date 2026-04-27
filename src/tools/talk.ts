import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildTalkTools(client: GatewayClient): ToolDef[] {
  const config: ToolDef = {
    name: "openclaw_talk_config",
    description:
      "Get / set the talk-mode config (push-to-talk, hold-to-listen, voice activity detection). Wraps `talk.config`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("talk.config", args ?? {}),
  };

  const mode: ToolDef = {
    name: "openclaw_talk_mode",
    description:
      "Get / set the active talk mode (e.g. continuous, manual). Wraps `talk.mode`.",
    inputSchema: z
      .object({
        mode: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("talk.mode", args ?? {}),
  };

  const speak: ToolDef = {
    name: "openclaw_talk_speak",
    description:
      "Make the agent speak a piece of text out loud (synthesizes + plays). Wraps `talk.speak`.",
    inputSchema: z
      .object({
        text: z.string().min(1),
      })
      .passthrough(),
    handler: async (args) => client.request("talk.speak", args ?? {}),
  };

  return [config, mode, speak];
}
