import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import { formatAgo } from "../format.js";
import { getMcpVersion } from "../version.js";
import type { ToolDef } from "./cron.js";

export function buildStatusTools(client: GatewayClient): ToolDef[] {
  const status: ToolDef = {
    name: "openclaw_status",
    description:
      "Get overall gateway status (uptime, agents, sessions, queues). Wraps the root-level `status` JSON-RPC method. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("status", {}),
  };

  const health: ToolDef = {
    name: "openclaw_health",
    description:
      "Combined health probe — server-side `health` JSON-RPC plus client-side metadata (MCP version, device pairing state, gateway URL, last successful call). Read-only. Use this for a one-shot 'is everything OK?' check.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => {
      let gateway: unknown = null;
      let gatewayError: string | null = null;
      try {
        gateway = await client.request("health", {});
      } catch (err) {
        gatewayError = err instanceof Error ? err.message : String(err);
      }
      const hello = client.getLastHello();
      const device = client.getDevice();
      const lastSuccessAtMs = client.getLastSuccessAtMs();
      return {
        gateway,
        gatewayError,
        client: {
          mcpVersion: getMcpVersion(),
          gatewayId: client.getGatewayId(),
          server: hello?.server ?? null,
          device: device
            ? { deviceId: device.deviceId, fingerprint: device.deviceId.slice(0, 16) }
            : null,
          lastSuccessAtMs,
          lastSuccessAgo: formatAgo(lastSuccessAtMs),
        },
      };
    },
  };

  const lastHeartbeat: ToolDef = {
    name: "openclaw_last_heartbeat",
    description:
      "Get the last heartbeat info (latest tick processed by the gateway). Wraps `last-heartbeat`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("last-heartbeat", {}),
  };

  const setHeartbeats: ToolDef = {
    name: "openclaw_set_heartbeats",
    description:
      "Toggle / configure heartbeat emission from the gateway. Wraps `set-heartbeats`. Pass `enabled` and any cadence params.",
    inputSchema: z
      .object({
        enabled: z.boolean().optional(),
        intervalMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("set-heartbeats", args ?? {}),
  };

  const systemPresence: ToolDef = {
    name: "openclaw_system_presence",
    description:
      "Get presence info (which devices are connected, when they last spoke). Wraps `system-presence`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("system-presence", {}),
  };

  const systemEvent: ToolDef = {
    name: "openclaw_system_event",
    description:
      "Emit a custom system event onto the gateway bus. Wraps `system-event`. Mostly used for tooling / debug — operators rarely call this directly.",
    inputSchema: z
      .object({
        event: z.string().min(1).describe("Event name"),
        payload: z.unknown().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("system-event", args ?? {}),
  };

  const wake: ToolDef = {
    name: "openclaw_wake",
    description:
      "Wake an agent / session out of idle. Wraps the root-level `wake` method. Pass agentId/sessionId.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("wake", args ?? {}),
  };

  const send: ToolDef = {
    name: "openclaw_send",
    description:
      "Generic root-level `send` — pushes a message into an agent / session via the gateway's default routing. Prefer the typed `openclaw_chat_send` or `openclaw_sessions_send` when possible.",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
        text: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("send", args ?? {}),
  };

  const agent: ToolDef = {
    name: "openclaw_agent",
    description:
      "Root-level `agent` method — gateway-specific shape (often returns the active/default agent context). Read-only in practice; consult openclaw_introspect output if the response is unexpected.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("agent", args ?? {}),
  };

  const agentIdentityGet: ToolDef = {
    name: "openclaw_agent_identity_get",
    description:
      "Get the gateway's agent identity (current default agent metadata). Wraps `agent.identity.get`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("agent.identity.get", {}),
  };

  const agentWait: ToolDef = {
    name: "openclaw_agent_wait",
    description:
      "Block until the agent finishes its current turn (or timeout). Wraps `agent.wait`. Long-running — uses the configured request timeout (default 30s).",
    inputSchema: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("agent.wait", args ?? {}),
  };

  const gatewayIdentityGet: ToolDef = {
    name: "openclaw_gateway_identity_get",
    description:
      "Get the gateway's own identity (id, version, owner, region). Wraps `gateway.identity.get`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("gateway.identity.get", {}),
  };

  return [
    status,
    health,
    lastHeartbeat,
    setHeartbeats,
    systemPresence,
    systemEvent,
    wake,
    send,
    agent,
    agentIdentityGet,
    agentWait,
    gatewayIdentityGet,
  ];
}
