import { z } from "zod";
import { passthroughHandler, splitInstance, withInstance, type ToolClient } from "./client.js";
import type { ToolDef } from "./cron.js";
import { mergeAt } from "./_merge.js";

export function buildSecretsTools(client: ToolClient): ToolDef[] {
  const reload: ToolDef = {
    name: "openclaw_secrets_reload",
    description:
      "Reload the gateway's secret store from disk. Wraps `secrets.reload`. Use after editing the secrets file out-of-band so the gateway picks up new values without a restart.",
    inputSchema: withInstance(z.object({}).passthrough()),
    handler: passthroughHandler(client, "secrets.reload"),
  };

  const resolve: ToolDef = {
    name: "openclaw_secrets_resolve",
    description:
      "Resolve a command-scoped secret. Wraps `secrets.resolve`. Wire format (verified live against gateway 2026.4.12+): `{ commandName: string }` — the gateway secrets subsystem is COMMAND-scoped, not arbitrary key/value. SENSITIVE — returns secret material; only use for debugging missing/wrong-values issues. For arbitrary API keys consumed by skills, use `openclaw_secrets_set` (which writes to the config tree, not the command-scoped secret store).",
    inputSchema: withInstance(z
      .object({
        commandName: z.string().min(1).describe("Command name whose secret to resolve."),
      })
      .passthrough()),
    handler: passthroughHandler(client, "secrets.resolve"),
  };

  const set: ToolDef = {
    name: "openclaw_secrets_set",
    description:
      "Store an arbitrary secret (API key, third-party token, etc.) in the gateway's config tree where skills can consume it. Internally calls `config.patch` with a `mergePath` so the value lands at `config.<scope>.<name>`. Default scope is `secrets` (creates `config.secrets.<name>`); override with `scope` for skill-scoped secrets like `tools.linkedin-outreach.proxycurlApiKey`. Note: this writes to the CONFIG tree, not the gateway's `secrets.resolve` command-scoped store (which has no public write API). After this call, restart-free — the next agent run sees the updated config.",
    inputSchema: withInstance(z.object({
      name: z.string().min(1).describe("Secret name (e.g. 'PROXYCURL_API_KEY', 'OPENAI_API_KEY')."),
      value: z.string().min(1).describe("Secret value."),
      scope: z
        .string()
        .optional()
        .describe("Dotted config path to nest under. Default 'secrets' creates config.secrets.<name>. Use e.g. 'tools.linkedin-outreach' for skill-scoped secrets."),
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const { name, value, scope } = rest as { name: string; value: string; scope?: string };
      const mergePath = `${scope ?? "secrets"}.${name}`;

      const get = (await client.request("config.get", {}, opts)) as {
        parsed?: Record<string, unknown>;
        baseHash?: string;
        hash?: string;
      };
      const baseHash = get.baseHash ?? get.hash;
      if (!baseHash) {
        throw new Error("config.get response missing baseHash/hash — cannot synthesize a secret.set patch.");
      }
      const merged = mergeAt(structuredClone(get.parsed ?? {}), mergePath, value);
      const result = (await client.request(
        "config.patch",
        { raw: JSON.stringify(merged), baseHash },
        opts,
      )) as { ok?: boolean; baseHash?: string };
      return {
        ok: result.ok ?? true,
        path: mergePath,
        baseHashAfter: result.baseHash,
        nextStep:
          "Skills consume the secret on next run — no restart needed. To verify, call openclaw_config_get and inspect the projected path.",
      };
    },
  };

  return [reload, resolve, set];
}
