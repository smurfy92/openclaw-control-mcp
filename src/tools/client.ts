import { z } from "zod";
import type { DeviceIdentity } from "../gateway/device.js";
import type { PairingPending } from "../gateway/client.js";

export type CallOpts = { instance?: string };

type LastHello = {
  type?: string;
  protocol?: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  [k: string]: unknown;
};

/**
 * Instance-aware façade exposed to every tool builder. Implemented by the
 * shim in `index.ts`, which routes each call to the cached `GatewayClient`
 * for the requested instance (creating it on first use). Tools never see the
 * real `GatewayClient` class — they always go through this interface so
 * per-call routing stays consistent.
 */
export interface ToolClient {
  request<T = unknown>(method: string, params?: unknown, opts?: CallOpts): Promise<T>;
  connect(opts?: CallOpts): Promise<unknown>;
  close(opts?: CallOpts): Promise<void>;
  getDevice(opts?: CallOpts): DeviceIdentity | null;
  getLastHello(opts?: CallOpts): LastHello | null;
  getPairingPending(opts?: CallOpts): PairingPending | null;
  getGatewayId(opts?: CallOpts): string;
  getLastSuccessAtMs(opts?: CallOpts): number | null;
}

const INSTANCE_DESCRIPTION =
  "Optional OpenClaw instance to route this call to (e.g. 'default', 'work'). Falls back to the active default instance, or the OPENCLAW_GATEWAY_URL/TOKEN env vars when set. List configured instances with openclaw_setup_list.";

const instanceField = z.string().min(1).max(64).optional().describe(INSTANCE_DESCRIPTION);

/**
 * Extend a tool's input schema with an optional `instance` field so every
 * call can target a non-default gateway without having to flip the active
 * default first. Preserves the source schema's strip/passthrough mode.
 */
export function withInstance<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.extend({ instance: instanceField });
}

/**
 * Pull `instance` out of validated args and return it alongside the rest of
 * the params. Centralised so handlers don't have to re-spell the cast.
 */
export function splitInstance(args: unknown): { rest: Record<string, unknown>; opts: CallOpts } {
  const a = (args ?? {}) as Record<string, unknown> & { instance?: unknown };
  const { instance, ...rest } = a;
  const opts: CallOpts = typeof instance === "string" && instance.length > 0 ? { instance } : {};
  return { rest, opts };
}

/**
 * Convenience wrapper for the dominant pattern: take args, strip `instance`,
 * and forward the rest to a single JSON-RPC method. Custom handlers (those
 * with extra enrichment logic) call `splitInstance` directly.
 */
export function passthroughHandler(client: ToolClient, method: string) {
  return async (args: unknown) => {
    const { rest, opts } = splitInstance(args);
    return client.request(method, rest, opts);
  };
}
