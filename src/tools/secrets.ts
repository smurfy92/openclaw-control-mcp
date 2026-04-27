import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildSecretsTools(client: GatewayClient): ToolDef[] {
  const reload: ToolDef = {
    name: "openclaw_secrets_reload",
    description:
      "Reload the gateway's secret store from disk / source. Wraps `secrets.reload`. Use after editing the secrets file out-of-band so the gateway picks up new values without a restart.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("secrets.reload", {}),
  };

  const resolve: ToolDef = {
    name: "openclaw_secrets_resolve",
    description:
      "Resolve a secret reference to its value. Wraps `secrets.resolve`. SENSITIVE — returns secret material; only use for debugging missing/wrong-values issues.",
    inputSchema: z
      .object({
        name: z.string().min(1).describe("Secret name / key"),
      })
      .passthrough(),
    handler: async (args) => client.request("secrets.resolve", args ?? {}),
  };

  return [reload, resolve];
}
