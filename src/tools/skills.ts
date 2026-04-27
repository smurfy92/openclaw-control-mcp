import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

export function buildSkillsTools(client: GatewayClient): ToolDef[] {
  const status: ToolDef = {
    name: "openclaw_skills_status",
    description:
      "Get the skills subsystem status (which skills are installed, enabled, recently updated). Wraps `skills.status`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("skills.status", {}),
  };

  const search: ToolDef = {
    name: "openclaw_skills_search",
    description:
      "Search the available skill catalog (installed and remote). Wraps `skills.search`. Read-only.",
    inputSchema: z
      .object({
        query: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("skills.search", args ?? {}),
  };

  const detail: ToolDef = {
    name: "openclaw_skills_detail",
    description:
      "Get detailed info on a specific skill (manifest, version, dependencies, install state). Wraps `skills.detail`. Read-only.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Skill id / slug"),
      })
      .passthrough(),
    handler: async (args) => client.request("skills.detail", args ?? {}),
  };

  const install: ToolDef = {
    name: "openclaw_skills_install",
    description:
      "Install a skill (or a specific version). Wraps `skills.install`. Mutates the gateway's skill set — confirm before calling.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Skill id to install"),
        version: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("skills.install", args ?? {}),
  };

  const update: ToolDef = {
    name: "openclaw_skills_update",
    description:
      "Update an installed skill to its latest (or a specified) version. Wraps `skills.update`. Mutates the gateway state.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe("Skill id to update"),
        version: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("skills.update", args ?? {}),
  };

  const bins: ToolDef = {
    name: "openclaw_skills_bins",
    description:
      "List the binaries / executables exposed by installed skills. Wraps `skills.bins`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("skills.bins", {}),
  };

  return [status, search, detail, install, update, bins];
}
