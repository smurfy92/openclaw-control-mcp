import { z } from "zod";
import { passthroughHandler, splitInstance, withInstance, type ToolClient } from "./client.js";
import type { ToolDef } from "./cron.js";
import { mergeAt, projectByPath } from "./_merge.js";

export function buildConfigTools(client: ToolClient): ToolDef[] {
  const get: ToolDef = {
    name: "openclaw_config_get",
    description:
      "Read the gateway's current configuration. Wraps `config.get`. Read-only. The gateway returns the full config; pass `path` to project to a sub-section client-side after fetch (the gateway itself does NOT support a `path` filter — verified live against 2026.4.12+).",
    inputSchema: withInstance(z
      .object({
        path: z.string().optional().describe("Dotted path applied client-side to project the response (e.g. 'channels.telegram'). Does not reduce wire traffic — the gateway always returns the full config."),
      })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const { path } = rest as { path?: string };
      const result = await client.request("config.get", {}, opts);
      if (!path) return result;
      // The gateway returns `{ path: "...", exists, raw, parsed: {...} }`.
      // Project against the parsed tree so callers can scope without a second fetch.
      const r = result as { parsed?: unknown; [k: string]: unknown };
      const projected = projectByPath(r.parsed, path);
      return { ...r, projectedPath: path, projected };
    },
  };

  const set: ToolDef = {
    name: "openclaw_config_set",
    description:
      "Replace a config value at a given path. Wraps `config.set`. Destructive — overwrites the previous value. Prefer openclaw_config_patch for partial updates.",
    inputSchema: withInstance(z
      .object({
        path: z.string().min(1).describe("Dotted path of the config key to set"),
        value: z.unknown().describe("New value (any JSON)"),
      })
      .passthrough()),
    handler: passthroughHandler(client, "config.set"),
  };

  const patch: ToolDef = {
    name: "openclaw_config_patch",
    description:
      "Optimistic-locked replace of the FULL gateway config (verified live against 2026.4.12+). Wraps `config.patch`. Wire format: `{ raw: string, baseHash: string }` where `raw` is the full config serialized as JSON and `baseHash` comes from a previous `openclaw_config_get` call. Pass `mergePath` + `mergeValue` for the convenience flow: this tool will fetch the current config, deep-merge your value at the given dotted path, compute the resulting `raw` JSON, and submit it with the freshly-read `baseHash`. Destructive — replaces the entire config atomically.",
    inputSchema: withInstance(z.object({
      raw: z.string().optional().describe("Full new config as a JSON string. Use this when you've already serialized the new state. Mutually exclusive with mergePath/mergeValue."),
      baseHash: z.string().optional().describe("Hash of the config the patch is based on. Required with `raw`. Get it from openclaw_config_get."),
      mergePath: z.string().optional().describe("Convenience: dotted path to merge `mergeValue` into. The tool fetches the current config and merges client-side."),
      mergeValue: z.unknown().optional().describe("Convenience: object/value to deep-merge at `mergePath`."),
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as {
        raw?: string;
        baseHash?: string;
        mergePath?: string;
        mergeValue?: unknown;
      };
      if (a.raw && a.baseHash) {
        return client.request("config.patch", { raw: a.raw, baseHash: a.baseHash }, opts);
      }
      if (a.mergePath !== undefined && a.mergeValue !== undefined) {
        const current = (await client.request("config.get", {}, opts)) as {
          parsed?: Record<string, unknown>;
          baseHash?: string;
          hash?: string;
        };
        const base = current.baseHash ?? current.hash;
        if (!base) {
          throw new Error("config.get response missing baseHash/hash — cannot synthesize a patch.");
        }
        const merged = mergeAt(structuredClone(current.parsed ?? {}), a.mergePath, a.mergeValue);
        return client.request("config.patch", { raw: JSON.stringify(merged), baseHash: base }, opts);
      }
      throw new Error(
        "config.patch requires either `{ raw, baseHash }` (advanced) or `{ mergePath, mergeValue }` (convenience).",
      );
    },
  };

  const apply: ToolDef = {
    name: "openclaw_config_apply",
    description:
      "Apply pending config changes (commit). Wraps `config.apply`. Destructive — propagates buffered config to running components.",
    inputSchema: withInstance(z.object({}).passthrough()),
    handler: passthroughHandler(client, "config.apply"),
  };

  const schema: ToolDef = {
    name: "openclaw_config_schema",
    description:
      "Get the JSON schema describing the gateway's config structure. Wraps `config.schema`. Read-only — useful before openclaw_config_set/patch to know which paths exist.",
    inputSchema: withInstance(z.object({}).passthrough()),
    handler: passthroughHandler(client, "config.schema"),
  };

  const schemaLookup: ToolDef = {
    name: "openclaw_config_schema_lookup",
    description:
      "Look up the schema description for a specific config path. Wraps `config.schema.lookup`. Read-only.",
    inputSchema: withInstance(z
      .object({
        path: z.string().min(1).describe("Dotted path to look up"),
      })
      .passthrough()),
    handler: passthroughHandler(client, "config.schema.lookup"),
  };

  return [get, set, patch, apply, schema, schemaLookup];
}
