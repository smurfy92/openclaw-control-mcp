import { z } from "zod";
import type { Store } from "../gateway/store.js";
import type { ToolDef } from "./cron.js";

export type SetupHooks = {
  reconfigure: (cfg: { gatewayUrl?: string; gatewayToken?: string; gatewayPassword?: string }) => Promise<void>;
  envOverride: () => { gatewayUrl: string | undefined; tokenSet: boolean; passwordSet: boolean };
};

export function buildSetupTools(store: Store, hooks: SetupHooks): ToolDef[] {
  const setup: ToolDef = {
    name: "openclaw_setup",
    description:
      "Persist the OpenClaw gateway URL and token to local config (~/.config/openclaw-control-mcp/store.json, mode 0600). Use this once after `claude mcp add openclaw-control` so you don't have to edit `~/.claude.json` by hand. Environment variables (OPENCLAW_GATEWAY_URL/TOKEN) still take precedence over the stored config — leave them unset to use what you persist here. After saving, the MCP closes any active connection so the next tool call uses the new credentials.",
    inputSchema: z.object({
      gatewayUrl: z
        .string()
        .min(1)
        .describe("WebSocket URL of the gateway, e.g. wss://openclaw-xxx.srv.hstgr.cloud or ws://127.0.0.1:18789"),
      gatewayToken: z
        .string()
        .min(1)
        .describe("Gateway login token (get it from your Hostinger VPS dashboard or the Control panel after login)"),
      gatewayPassword: z
        .string()
        .optional()
        .describe("Optional extra password if your gateway is configured with one"),
    }),
    handler: async (args) => {
      const a = args as { gatewayUrl: string; gatewayToken: string; gatewayPassword?: string };
      if (!/^wss?:\/\//i.test(a.gatewayUrl)) {
        throw new Error("gatewayUrl must start with ws:// or wss://");
      }
      await store.saveConfig({
        gatewayUrl: a.gatewayUrl.trim(),
        gatewayToken: a.gatewayToken.trim(),
        gatewayPassword: a.gatewayPassword?.trim() || undefined,
      });
      await hooks.reconfigure({
        gatewayUrl: a.gatewayUrl.trim(),
        gatewayToken: a.gatewayToken.trim(),
        gatewayPassword: a.gatewayPassword?.trim(),
      });
      const env = hooks.envOverride();
      return {
        ok: true,
        savedTo: "~/.config/openclaw-control-mcp/store.json",
        gatewayUrl: a.gatewayUrl,
        gatewayPasswordSet: !!a.gatewayPassword,
        envOverridesPresent: !!env.gatewayUrl,
        nextStep: env.gatewayUrl
          ? "Note: an OPENCLAW_GATEWAY_URL env var is set on the running MCP and will override this stored config until you remove it."
          : "Call openclaw_device_status to trigger the connect handshake. First time pairs the device (you approve in the Control panel → Nodes tab); after approval, scoped tools (cron, sessions, ...) work.",
      };
    },
  };

  const setupShow: ToolDef = {
    name: "openclaw_setup_show",
    description:
      "Show the currently resolved gateway configuration (URL, whether token/password are set, source = env vs store). Does NOT print the token itself.",
    inputSchema: z.object({}),
    handler: async () => {
      const env = hooks.envOverride();
      const stored = await store.loadConfig();
      const effectiveUrl = env.gatewayUrl ?? stored.gatewayUrl;
      const effectiveSource = env.gatewayUrl ? "env" : stored.gatewayUrl ? "store" : "none";
      const secretsLocation = await store.secretsLocation();
      return {
        effective: {
          gatewayUrl: effectiveUrl,
          tokenSet: env.tokenSet || !!stored.gatewayToken,
          passwordSet: env.passwordSet || !!stored.gatewayPassword,
          source: effectiveSource,
          secretsLocation,
        },
        env: {
          gatewayUrl: env.gatewayUrl ?? null,
          tokenSet: env.tokenSet,
          passwordSet: env.passwordSet,
        },
        store: {
          gatewayUrl: stored.gatewayUrl ?? null,
          tokenSet: !!stored.gatewayToken,
          passwordSet: !!stored.gatewayPassword,
          savedAtMs: stored.savedAtMs ?? null,
        },
      };
    },
  };

  const setupClear: ToolDef = {
    name: "openclaw_setup_clear",
    description:
      "Clear the persisted gateway config (does not touch device identity or device tokens). After this, the MCP falls back to env vars or errors with 'configure first'.",
    inputSchema: z.object({}),
    handler: async () => {
      await store.clearConfig();
      await hooks.reconfigure({});
      return { ok: true, cleared: ["gatewayUrl", "gatewayToken", "gatewayPassword"] };
    },
  };

  return [setup, setupShow, setupClear];
}
