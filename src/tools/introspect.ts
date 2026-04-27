import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import type { Store } from "../gateway/store.js";
import type { ToolDef } from "./cron.js";

export function buildIntrospectTools(client: GatewayClient, store: Store): ToolDef[] {
  const introspect: ToolDef = {
    name: "openclaw_introspect",
    description:
      "Inspect the OpenClaw gateway capabilities. Triggers a connect (if not already), then returns the server version, this device's role/scopes, and the full list of JSON-RPC `methods` and `events` the gateway publishes in its hello-ok handshake. Use this to discover what methods you can call via `openclaw_call` (or to know which ones still need a typed wrapper).",
    inputSchema: z.object({}),
    handler: async () => {
      let connectError: string | null = null;
      try {
        await client.connect();
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      const hello = client.getLastHello();
      const tokenEntry = await store.loadToken(client.getGatewayId());
      const features = (hello?.features ?? null) as
        | { methods?: string[]; events?: string[] }
        | null;

      const methods = features?.methods ?? [];
      const events = features?.events ?? [];
      const methodsByDomain: Record<string, string[]> = {};
      for (const m of methods) {
        const dot = m.indexOf(".");
        const domain = dot === -1 ? "(root)" : m.slice(0, dot);
        (methodsByDomain[domain] ??= []).push(m);
      }
      for (const list of Object.values(methodsByDomain)) list.sort();

      return {
        server: hello?.server ?? null,
        role: tokenEntry?.role ?? null,
        scopes: tokenEntry?.scopes ?? [],
        connectError,
        methodCount: methods.length,
        eventCount: events.length,
        methodsByDomain,
        events: [...events].sort(),
      };
    },
  };

  const call: ToolDef = {
    name: "openclaw_call",
    description:
      "DESTRUCTIVE ESCAPE HATCH — call ANY JSON-RPC method on the gateway with arbitrary params. Use this to operate on endpoints that don't yet have a typed wrapper. The user must validate the exact method name and params on every call (especially anything matching `*.add|remove|delete|update|create|write|terminate|reset|approve|reject`). For read-only inspection prefer the typed tools (`openclaw_cron_list`, `openclaw_introspect`, …) — `openclaw_call` should only be used when no typed alternative exists.",
    inputSchema: z.object({
      method: z
        .string()
        .min(1)
        .describe("JSON-RPC method name, e.g. 'cron.list', 'session.list'. Discover the full set via openclaw_introspect."),
      params: z
        .unknown()
        .optional()
        .describe("Method params. Pass an object matching the gateway's expected shape; consult an existing typed tool for that domain to learn the schema."),
    }),
    handler: async (args) => {
      const { method, params } = args as { method: string; params?: unknown };
      return client.request(method, params);
    },
  };

  return [introspect, call];
}
