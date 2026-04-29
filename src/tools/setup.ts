import { z } from "zod";
import { DEFAULT_INSTANCE, type Store } from "../gateway/store.js";
import type { ToolDef } from "./cron.js";

export type SetupHooks = {
  reconfigure: (
    cfg: { gatewayUrl?: string; gatewayToken?: string; gatewayPassword?: string },
    instance?: string,
  ) => Promise<void>;
  envOverride: () => { gatewayUrl: string | undefined; tokenSet: boolean; passwordSet: boolean };
};

export function buildSetupTools(store: Store, hooks: SetupHooks): ToolDef[] {
  const setup: ToolDef = {
    name: "openclaw_setup",
    description:
      "Persist a named OpenClaw gateway config (URL + token) to local store. Default instance name is 'default'. Pass `instance` to manage multiple gateways (e.g. 'perso', 'work') from the same MCP. Env vars (OPENCLAW_GATEWAY_URL/TOKEN) still override everything stored here — leave them unset to use named instances. After saving, the matching client connection is closed so the next tool call re-handshakes with the new credentials.",
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
      instance: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_-]+$/, "instance must be alphanumeric (with - or _)")
        .optional()
        .describe(
          "Instance name (e.g. 'default', 'perso', 'work'). Defaults to 'default'. The first instance configured becomes the default automatically.",
        ),
      makeDefault: z
        .boolean()
        .optional()
        .describe("If true, also set this instance as the active default (for tools that don't pass `instance`)."),
    }),
    handler: async (args) => {
      const a = args as {
        gatewayUrl: string;
        gatewayToken: string;
        gatewayPassword?: string;
        instance?: string;
        makeDefault?: boolean;
      };
      if (!/^wss?:\/\//i.test(a.gatewayUrl)) {
        throw new Error("gatewayUrl must start with ws:// or wss://");
      }
      const instance = a.instance ?? DEFAULT_INSTANCE;
      await store.saveConfig(
        {
          gatewayUrl: a.gatewayUrl.trim(),
          gatewayToken: a.gatewayToken.trim(),
          gatewayPassword: a.gatewayPassword?.trim() || undefined,
        },
        instance,
      );
      if (a.makeDefault) await store.setDefaultInstance(instance);
      await hooks.reconfigure(
        {
          gatewayUrl: a.gatewayUrl.trim(),
          gatewayToken: a.gatewayToken.trim(),
          gatewayPassword: a.gatewayPassword?.trim(),
        },
        instance,
      );
      const env = hooks.envOverride();
      const all = await store.loadConfigs();
      return {
        ok: true,
        savedTo: "~/.config/openclaw-control-mcp/store.json",
        instance,
        defaultInstance: all.defaultInstance,
        knownInstances: Object.keys(all.configs).sort(),
        gatewayUrl: a.gatewayUrl,
        gatewayPasswordSet: !!a.gatewayPassword,
        envOverridesPresent: !!env.gatewayUrl,
        nextStep: env.gatewayUrl
          ? "Note: an OPENCLAW_GATEWAY_URL env var is set on the running MCP and will override this stored config until you remove it."
          : `Call openclaw_device_status to trigger the connect handshake on '${instance}'. First time pairs the device (approve in the Control panel → Devices tab); after approval, scoped tools (cron, sessions, ...) work.`,
      };
    },
  };

  const setupShow: ToolDef = {
    name: "openclaw_setup_show",
    description:
      "Show the currently resolved gateway configuration for an instance (default 'default' or whichever instance is the active default). Does NOT print tokens. Pass `instance` to inspect a non-default one.",
    inputSchema: z.object({
      instance: z
        .string()
        .optional()
        .describe("Instance name to inspect. Defaults to the active default instance."),
    }),
    handler: async (args) => {
      const a = (args ?? {}) as { instance?: string };
      const env = hooks.envOverride();
      const all = await store.loadConfigs();
      const instance = a.instance ?? all.defaultInstance ?? DEFAULT_INSTANCE;
      const stored = all.configs[instance] ?? {};
      const effectiveUrl = env.gatewayUrl ?? stored.gatewayUrl;
      const effectiveSource = env.gatewayUrl ? "env" : stored.gatewayUrl ? "store" : "none";
      const secretsLocation = await store.secretsLocation();
      return {
        instance,
        defaultInstance: all.defaultInstance,
        knownInstances: Object.keys(all.configs).sort(),
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

  const setupList: ToolDef = {
    name: "openclaw_setup_list",
    description:
      "List every persisted gateway instance (name + URL + whether token/password are set, never the values). Plus the active default instance and where secrets live (file vs OS keychain).",
    inputSchema: z.object({}),
    handler: async () => {
      const all = await store.loadConfigs();
      const env = hooks.envOverride();
      const secretsLocation = await store.secretsLocation();
      return {
        defaultInstance: all.defaultInstance,
        secretsLocation,
        envOverridesPresent: !!env.gatewayUrl,
        instances: Object.entries(all.configs)
          .map(([name, cfg]) => ({
            name,
            isDefault: name === all.defaultInstance,
            gatewayUrl: cfg.gatewayUrl ?? null,
            tokenSet: !!cfg.gatewayToken,
            passwordSet: !!cfg.gatewayPassword,
            savedAtMs: cfg.savedAtMs ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };

  const setupSelectDefault: ToolDef = {
    name: "openclaw_setup_select_default",
    description:
      "Switch the active default instance — every subsequent tool call (cron.list, sessions.list, etc.) will route to this instance unless an env var overrides. Closes existing client connections so they re-handshake with the new instance's credentials.",
    inputSchema: z.object({
      instance: z.string().min(1).describe("Instance name to set as default. Must already exist (use openclaw_setup first)."),
    }),
    handler: async (args) => {
      const a = args as { instance: string };
      await store.setDefaultInstance(a.instance);
      // Reset all clients so the next call resolves the new default cleanly.
      await hooks.reconfigure({});
      const all = await store.loadConfigs();
      return {
        ok: true,
        defaultInstance: all.defaultInstance,
        knownInstances: Object.keys(all.configs).sort(),
      };
    },
  };

  const setupClear: ToolDef = {
    name: "openclaw_setup_clear",
    description:
      "Clear a persisted gateway config. By default clears every instance; pass `instance` to clear just one. Does NOT touch the device identity or device tokens. After this, the MCP falls back to env vars or errors with 'configure first'.",
    inputSchema: z.object({
      instance: z
        .string()
        .optional()
        .describe("If set, clear only this named instance. Omit to clear all instances."),
    }),
    handler: async (args) => {
      const a = (args ?? {}) as { instance?: string };
      await store.clearConfig(a.instance);
      await hooks.reconfigure({}, a.instance);
      const all = await store.loadConfigs();
      return {
        ok: true,
        cleared: a.instance ?? "all",
        remainingInstances: Object.keys(all.configs).sort(),
        defaultInstance: all.defaultInstance ?? null,
      };
    },
  };

  return [setup, setupShow, setupList, setupSelectDefault, setupClear];
}
