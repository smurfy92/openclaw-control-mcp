import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { Store } from "../gateway/store.js";
import type { ToolDef } from "./cron.js";

export function buildDeviceTools(client: GatewayClient, store: Store): ToolDef[] {
  const deviceStatus: ToolDef = {
    name: "openclaw_device_status",
    description:
      "Show this MCP's local device identity, pairing status, current scopes (if any), and any pending pairing requestId. Triggers a fresh connect attempt, so it doubles as a 'retry pairing' command after approval. Use when scoped methods fail with 'missing scope: operator.read'.",
    inputSchema: z.object({}),
    handler: async () => {
      let connectError: string | null = null;
      try {
        await client.connect();
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      const device = client.getDevice();
      const tokenEntry = await store.loadToken(client.getGatewayId());
      const hello = client.getLastHello();
      const pending = client.getPairingPending();

      let nextStep: string;
      if (tokenEntry && hello) {
        nextStep = `Device paired. Scopes: ${tokenEntry.scopes.join(", ") || "<none>"}.`;
      } else if (pending) {
        nextStep = `Pairing required. Open the OpenClaw Control panel → Devices tab → approve request ${pending.requestId}. Then call openclaw_device_status again to retry.`;
      } else if (connectError) {
        nextStep = `Connect attempt failed: ${connectError}`;
      } else {
        nextStep = "No pairing state captured yet. Call any scoped method to trigger a connect.";
      }

      return {
        device: device
          ? {
              deviceId: device.deviceId,
              publicKeyFingerprint: device.deviceId.slice(0, 16),
            }
          : null,
        gatewayId: client.getGatewayId(),
        paired: !!(tokenEntry && hello),
        pendingPairing: pending,
        scopes: tokenEntry?.scopes ?? [],
        role: tokenEntry?.role ?? null,
        server: hello?.server ?? null,
        nextStep,
      };
    },
  };

  const devicePairList: ToolDef = {
    name: "openclaw_device_pair_list",
    description:
      "List pending and paired devices known to the gateway. Useful for confirming that this MCP's device shows up in 'pending' before approval. Wraps `device.pair.list` (operator scope).",
    inputSchema: z.object({}),
    handler: async () => client.request("device.pair.list", {}),
  };

  const devicePairApprove: ToolDef = {
    name: "openclaw_device_pair_approve",
    description:
      "Approve a pending device pairing request. Requires operator.write scope. Wraps `device.pair.approve`.",
    inputSchema: z.object({
      requestId: z.string().min(1).describe("Pairing request id from openclaw_device_pair_list (pending entries)"),
    }),
    handler: async (args) => client.request("device.pair.approve", args ?? {}),
  };

  const devicePairReject: ToolDef = {
    name: "openclaw_device_pair_reject",
    description: "Reject a pending device pairing request. Wraps `device.pair.reject`.",
    inputSchema: z.object({
      requestId: z.string().min(1).describe("Pairing request id from openclaw_device_pair_list (pending entries)"),
    }),
    handler: async (args) => client.request("device.pair.reject", args ?? {}),
  };

  const devicePairRemove: ToolDef = {
    name: "openclaw_device_pair_remove",
    description:
      "Remove a paired device from the gateway. Wraps `device.pair.remove`. Destructive — the device will need to re-pair to reconnect.",
    inputSchema: z.object({
      deviceId: z.string().min(1).describe("Device id (hex) to unpair"),
    }),
    handler: async (args) => client.request("device.pair.remove", args ?? {}),
  };

  const deviceTokenRevoke: ToolDef = {
    name: "openclaw_device_token_revoke",
    description:
      "Revoke a device's authentication token. Wraps `device.token.revoke`. Destructive — the device must re-pair (or use a freshly issued token).",
    inputSchema: z.object({
      deviceId: z.string().min(1).describe("Device id whose token to revoke"),
    }),
    handler: async (args) => client.request("device.token.revoke", args ?? {}),
  };

  const deviceTokenRotate: ToolDef = {
    name: "openclaw_device_token_rotate",
    description:
      "Rotate a device's authentication token (issues a new one, invalidates the old). Wraps `device.token.rotate`. Destructive — the device's currently cached token stops working.",
    inputSchema: z.object({
      deviceId: z.string().min(1).describe("Device id whose token to rotate"),
    }),
    handler: async (args) => client.request("device.token.rotate", args ?? {}),
  };

  return [
    deviceStatus,
    devicePairList,
    devicePairApprove,
    devicePairReject,
    devicePairRemove,
    deviceTokenRevoke,
    deviceTokenRotate,
  ];
}
