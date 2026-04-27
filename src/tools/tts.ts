import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildTtsTools(client: GatewayClient): ToolDef[] {
  const status: ToolDef = {
    name: "openclaw_tts_status",
    description:
      "Get the TTS subsystem status (enabled, current provider, voice). Wraps `tts.status`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("tts.status", {}),
  };

  const enable: ToolDef = {
    name: "openclaw_tts_enable",
    description: "Enable text-to-speech output. Wraps `tts.enable`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("tts.enable", args ?? {}),
  };

  const disable: ToolDef = {
    name: "openclaw_tts_disable",
    description: "Disable text-to-speech output. Wraps `tts.disable`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("tts.disable", args ?? {}),
  };

  const providers: ToolDef = {
    name: "openclaw_tts_providers",
    description:
      "List available TTS providers (and their voices / models). Wraps `tts.providers`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("tts.providers", {}),
  };

  const setProvider: ToolDef = {
    name: "openclaw_tts_setProvider",
    description:
      "Switch the active TTS provider / voice. Wraps `tts.setProvider`.",
    inputSchema: z
      .object({
        provider: z.string().min(1),
        voice: z.string().optional(),
        model: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("tts.setProvider", args ?? {}),
  };

  const convert: ToolDef = {
    name: "openclaw_tts_convert",
    description:
      "Synthesize a piece of text to audio. Wraps `tts.convert`. Returns audio / a download URL depending on the gateway config.",
    inputSchema: z
      .object({
        text: z.string().min(1),
        voice: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("tts.convert", args ?? {}),
  };

  return [status, enable, disable, providers, setProvider, convert];
}
