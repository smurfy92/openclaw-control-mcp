import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildConfigTools(client: GatewayClient): ToolDef[] {
  const get: ToolDef = {
    name: "openclaw_config_get",
    description:
      "Read the gateway's current configuration. Wraps `config.get`. Read-only. Pass `path` to scope to a sub-section if supported.",
    inputSchema: z
      .object({
        path: z.string().optional().describe("Optional dotted path to fetch a sub-tree only"),
      })
      .passthrough(),
    handler: async (args) => client.request("config.get", args ?? {}),
  };

  const set: ToolDef = {
    name: "openclaw_config_set",
    description:
      "Replace a config value at a given path. Wraps `config.set`. Destructive — overwrites the previous value. Prefer openclaw_config_patch for partial updates.",
    inputSchema: z
      .object({
        path: z.string().min(1).describe("Dotted path of the config key to set"),
        value: z.unknown().describe("New value (any JSON)"),
      })
      .passthrough(),
    handler: async (args) => client.request("config.set", args ?? {}),
  };

  const patch: ToolDef = {
    name: "openclaw_config_patch",
    description:
      "Merge a partial object into the existing config at a given path. Wraps `config.patch`. Destructive — modifies live config.",
    inputSchema: z
      .object({
        path: z.string().optional().describe("Dotted path; omit to patch root"),
        value: z.unknown().describe("Partial object to merge"),
      })
      .passthrough(),
    handler: async (args) => client.request("config.patch", args ?? {}),
  };

  const apply: ToolDef = {
    name: "openclaw_config_apply",
    description:
      "Apply pending config changes (commit). Wraps `config.apply`. Destructive — propagates buffered config to running components.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("config.apply", args ?? {}),
  };

  const schema: ToolDef = {
    name: "openclaw_config_schema",
    description:
      "Get the JSON schema describing the gateway's config structure. Wraps `config.schema`. Read-only — useful before openclaw_config_set/patch to know which paths exist.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("config.schema", {}),
  };

  const schemaLookup: ToolDef = {
    name: "openclaw_config_schema_lookup",
    description:
      "Look up the schema description for a specific config path. Wraps `config.schema.lookup`. Read-only.",
    inputSchema: z
      .object({
        path: z.string().min(1).describe("Dotted path to look up"),
      })
      .passthrough(),
    handler: async (args) => client.request("config.schema.lookup", args ?? {}),
  };

  return [get, set, patch, apply, schema, schemaLookup];
}
