import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

const agentIdOnly = z.object({ agentId: z.string().min(1).describe("Agent id, e.g. 'main'") });

export function buildAgentsTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_agents_list",
    description:
      "List configured agents on the gateway (e.g. 'main', custom agents). Wraps `agents.list`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("agents.list", {}),
  };

  const create: ToolDef = {
    name: "openclaw_agents_create",
    description:
      "Create a new agent configuration. Wraps `agents.create`. Pass agentId, displayName, model, system prompt, etc.; call openclaw_agents_list first to see the shape of an existing agent.",
    inputSchema: z
      .object({
        agentId: z.string().min(1).optional(),
        id: z.string().optional(),
        displayName: z.string().optional(),
        model: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("agents.create", args ?? {}),
  };

  const update: ToolDef = {
    name: "openclaw_agents_update",
    description:
      "Update an existing agent's configuration. Wraps `agents.update`. Pass agentId + the fields to change.",
    inputSchema: agentIdOnly.passthrough(),
    handler: async (args) => client.request("agents.update", args ?? {}),
  };

  const remove: ToolDef = {
    name: "openclaw_agents_delete",
    description:
      "Delete an agent configuration. Wraps `agents.delete`. Destructive — confirm before calling. Sessions tied to this agent may be orphaned.",
    inputSchema: agentIdOnly,
    handler: async (args) => client.request("agents.delete", args ?? {}),
  };

  const filesList: ToolDef = {
    name: "openclaw_agents_files_list",
    description:
      "List files attached to an agent (instructions, system files, etc.). Wraps `agents.files.list`. Read-only.",
    inputSchema: agentIdOnly.passthrough(),
    handler: async (args) => client.request("agents.files.list", args ?? {}),
  };

  const filesGet: ToolDef = {
    name: "openclaw_agents_files_get",
    description:
      "Fetch a specific agent file's contents. Wraps `agents.files.get`. Read-only.",
    inputSchema: z
      .object({
        agentId: z.string().min(1),
        path: z.string().min(1).optional(),
        name: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("agents.files.get", args ?? {}),
  };

  const filesSet: ToolDef = {
    name: "openclaw_agents_files_set",
    description:
      "Write or overwrite an agent file. Wraps `agents.files.set`. Destructive — overwrites existing content. Pass agentId, path/name, and the file body.",
    inputSchema: z
      .object({
        agentId: z.string().min(1),
        path: z.string().min(1).optional(),
        name: z.string().optional(),
        content: z.string().optional(),
        body: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("agents.files.set", args ?? {}),
  };

  return [list, create, update, remove, filesList, filesGet, filesSet];
}
