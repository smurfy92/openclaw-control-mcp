import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { ToolDef } from "./cron.js";

const nodeIdOnly = z.object({
  nodeId: z.string().min(1).describe("Node id"),
});

export function buildNodeTools(client: GatewayClient): ToolDef[] {
  const list: ToolDef = {
    name: "openclaw_node_list",
    description:
      "List nodes registered with this gateway (worker / canvas / sub-gateway nodes). Wraps `node.list`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("node.list", {}),
  };

  const describe: ToolDef = {
    name: "openclaw_node_describe",
    description:
      "Describe a specific node — capabilities, host, version, last heartbeat. Wraps `node.describe`. Read-only.",
    inputSchema: nodeIdOnly.passthrough(),
    handler: async (args) => client.request("node.describe", args ?? {}),
  };

  const invoke: ToolDef = {
    name: "openclaw_node_invoke",
    description:
      "Invoke a method on a specific node (RPC routed through the gateway). Wraps `node.invoke`. Mutates depending on the target method.",
    inputSchema: z
      .object({
        nodeId: z.string().min(1),
        method: z.string().min(1),
        params: z.unknown().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("node.invoke", args ?? {}),
  };

  const invokeResult: ToolDef = {
    name: "openclaw_node_invoke_result",
    description:
      "Fetch the result of a previously-issued node invocation. Wraps `node.invoke.result`. Read-only.",
    inputSchema: z
      .object({
        invocationId: z.string().min(1),
      })
      .passthrough(),
    handler: async (args) => client.request("node.invoke.result", args ?? {}),
  };

  const event: ToolDef = {
    name: "openclaw_node_event",
    description:
      "Emit an event toward a node (or the gateway-side node bus). Wraps `node.event`.",
    inputSchema: z
      .object({
        event: z.string().min(1),
        nodeId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("node.event", args ?? {}),
  };

  const rename: ToolDef = {
    name: "openclaw_node_rename",
    description:
      "Rename a node (display name / id). Wraps `node.rename`. Mutates.",
    inputSchema: z
      .object({
        nodeId: z.string().min(1),
        newName: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("node.rename", args ?? {}),
  };

  const pairList: ToolDef = {
    name: "openclaw_node_pair_list",
    description:
      "List node pairing requests (pending and resolved). Wraps `node.pair.list`. Read-only.",
    inputSchema: z.object({}).passthrough(),
    handler: async () => client.request("node.pair.list", {}),
  };

  const pairRequest: ToolDef = {
    name: "openclaw_node_pair_request",
    description:
      "Request pairing for a new node. Wraps `node.pair.request`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("node.pair.request", args ?? {}),
  };

  const pairVerify: ToolDef = {
    name: "openclaw_node_pair_verify",
    description:
      "Verify a node pairing handshake. Wraps `node.pair.verify`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("node.pair.verify", args ?? {}),
  };

  const pairApprove: ToolDef = {
    name: "openclaw_node_pair_approve",
    description:
      "Approve a pending node pairing request. Wraps `node.pair.approve`. Mutates — node gains gateway access.",
    inputSchema: z
      .object({
        requestId: z.string().min(1),
      })
      .passthrough(),
    handler: async (args) => client.request("node.pair.approve", args ?? {}),
  };

  const pairReject: ToolDef = {
    name: "openclaw_node_pair_reject",
    description:
      "Reject a pending node pairing request. Wraps `node.pair.reject`.",
    inputSchema: z
      .object({
        requestId: z.string().min(1),
      })
      .passthrough(),
    handler: async (args) => client.request("node.pair.reject", args ?? {}),
  };

  const pendingPull: ToolDef = {
    name: "openclaw_node_pending_pull",
    description:
      "Pull pending work items destined for a node (queue drain). Wraps `node.pending.pull`. Read-and-mutate (work items leave the pending queue).",
    inputSchema: nodeIdOnly.passthrough(),
    handler: async (args) => client.request("node.pending.pull", args ?? {}),
  };

  const pendingDrain: ToolDef = {
    name: "openclaw_node_pending_drain",
    description:
      "Drain (clear) all pending work items for a node. Wraps `node.pending.drain`. Destructive — discards queued work.",
    inputSchema: nodeIdOnly.passthrough(),
    handler: async (args) => client.request("node.pending.drain", args ?? {}),
  };

  const pendingEnqueue: ToolDef = {
    name: "openclaw_node_pending_enqueue",
    description:
      "Enqueue a new work item for a node. Wraps `node.pending.enqueue`. Mutates.",
    inputSchema: z
      .object({
        nodeId: z.string().min(1),
      })
      .passthrough(),
    handler: async (args) => client.request("node.pending.enqueue", args ?? {}),
  };

  const pendingAck: ToolDef = {
    name: "openclaw_node_pending_ack",
    description:
      "Acknowledge / commit completion of a pending work item. Wraps `node.pending.ack`.",
    inputSchema: z
      .object({
        nodeId: z.string().min(1),
        itemId: z.string().optional(),
      })
      .passthrough(),
    handler: async (args) => client.request("node.pending.ack", args ?? {}),
  };

  const canvasRefresh: ToolDef = {
    name: "openclaw_node_canvas_capability_refresh",
    description:
      "Refresh the canvas capability map for nodes (re-registers what each canvas node can do). Wraps `node.canvas.capability.refresh`.",
    inputSchema: z.object({}).passthrough(),
    handler: async (args) => client.request("node.canvas.capability.refresh", args ?? {}),
  };

  return [
    list,
    describe,
    invoke,
    invokeResult,
    event,
    rename,
    pairList,
    pairRequest,
    pairVerify,
    pairApprove,
    pairReject,
    pendingPull,
    pendingDrain,
    pendingEnqueue,
    pendingAck,
    canvasRefresh,
  ];
}
