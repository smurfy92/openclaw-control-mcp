import { z } from "zod";
import type { Store } from "../gateway/store.js";
import { passthroughHandler, splitInstance, withInstance, type ToolClient } from "./client.js";
import type { ToolDef } from "./cron.js";

export function buildDeviceTools(client: ToolClient, store: Store): ToolDef[] {
  const deviceStatus: ToolDef = {
    name: "openclaw_device_status",
    description:
      "Show this MCP's local device identity, pairing status, current scopes (if any), and any pending pairing requestId. Triggers a fresh connect attempt, so it doubles as a 'retry pairing' command after approval. Use when scoped methods fail with 'missing scope: operator.read'.",
    inputSchema: withInstance(z.object({})),
    handler: async (args) => {
      const { opts } = splitInstance(args);
      let connectError: string | null = null;
      try {
        await client.connect(opts);
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      const device = client.getDevice(opts);
      const tokenEntry = await store.loadToken(client.getGatewayId(opts));
      const hello = client.getLastHello(opts);
      const pending = client.getPairingPending(opts);

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
        gatewayId: client.getGatewayId(opts),
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
    inputSchema: withInstance(z.object({})),
    handler: passthroughHandler(client, "device.pair.list"),
  };

  const devicePairApprove: ToolDef = {
    name: "openclaw_device_pair_approve",
    description:
      "Approve a pending device pairing request. Requires operator.write scope. Wraps `device.pair.approve`.",
    inputSchema: withInstance(z.object({
      requestId: z.string().min(1).describe("Pairing request id from openclaw_device_pair_list (pending entries)"),
    })),
    handler: passthroughHandler(client, "device.pair.approve"),
  };

  const devicePairReject: ToolDef = {
    name: "openclaw_device_pair_reject",
    description: "Reject a pending device pairing request. Wraps `device.pair.reject`.",
    inputSchema: withInstance(z.object({
      requestId: z.string().min(1).describe("Pairing request id from openclaw_device_pair_list (pending entries)"),
    })),
    handler: passthroughHandler(client, "device.pair.reject"),
  };

  const devicePairRemove: ToolDef = {
    name: "openclaw_device_pair_remove",
    description:
      "Remove a paired device from the gateway. Wraps `device.pair.remove`. Destructive — the device will need to re-pair to reconnect.",
    inputSchema: withInstance(z.object({
      deviceId: z.string().min(1).describe("Device id (hex) to unpair"),
    })),
    handler: passthroughHandler(client, "device.pair.remove"),
  };

  const deviceTokenRevoke: ToolDef = {
    name: "openclaw_device_token_revoke",
    description:
      "Revoke a device's authentication token. Wraps `device.token.revoke`. Destructive — the device must re-pair (or use a freshly issued token).",
    inputSchema: withInstance(z.object({
      deviceId: z.string().min(1).describe("Device id whose token to revoke"),
    })),
    handler: passthroughHandler(client, "device.token.revoke"),
  };

  const deviceTokenRotate: ToolDef = {
    name: "openclaw_device_token_rotate",
    description:
      "Rotate a device's authentication token (issues a new one, invalidates the old). Wraps `device.token.rotate`. Destructive — the device's currently cached token stops working.",
    inputSchema: withInstance(z.object({
      deviceId: z.string().min(1).describe("Device id whose token to rotate"),
    })),
    handler: passthroughHandler(client, "device.token.rotate"),
  };

  const deviceRepair: ToolDef = {
    name: "openclaw_device_repair",
    description:
      "Recover from the `expected Uint8Array of length 32, got length=0` failure mode (empty `device.privateKey`). Backs up `store.json` to `store.json.bak.<ts>`, wipes the broken device + cached tokens (keeps gateway URL + token configs), and drops the matching keychain entries. The next call to any scoped tool regenerates a fresh Ed25519 keypair and surfaces a new `pendingPairing.requestId` to approve in the Control panel. The `instance` arg is accepted but currently no-op — the local Store is shared across all instances. **Destructive — run only when openclaw_device_status reports the empty-private-key failure mode.**",
    inputSchema: withInstance(z.object({})),
    handler: async () => {
      const integrity = await store.deviceIntegrity();
      const result = await store.repairDevice();
      return {
        ok: true,
        integrityBefore: integrity,
        backupPath: result.backupPath,
        wiped: result.wiped,
        nextStep:
          "Call openclaw_device_status to trigger a fresh keypair generation; a new pendingPairing.requestId will be surfaced. Approve it in the Control panel → Devices tab. Then call openclaw_setup again with the same gatewayUrl/token to force a clean reconnect.",
      };
    },
  };

  return [
    deviceStatus,
    devicePairList,
    devicePairApprove,
    devicePairReject,
    devicePairRemove,
    deviceTokenRevoke,
    deviceTokenRotate,
    deviceRepair,
  ];
}
