#!/usr/bin/env node
// ADR-003 — Single-process shim with per-instance client cache. See docs/adr/003-single-process-shim-with-per-instance-client-cache.md.
// ADR-005 — Streamable HTTP transport. See docs/adr/005-http-streamable-transport.md.
import { createServer as createHttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { formatAgo } from "./format.js";
import { GatewayClient } from "./gateway/client.js";
import { MockGateway } from "./gateway/mock.js";
import { mergeCreds, Store } from "./gateway/store.js";
import type { CallOpts, ToolClient } from "./tools/client.js";
import { getMcpVersion } from "./version.js";
import { buildAdminTools } from "./tools/admin.js";
import { buildAgentsTools } from "./tools/agents.js";
import { buildChannelsTools } from "./tools/channels.js";
import { buildChatTools } from "./tools/chat.js";
import { buildConfigTools } from "./tools/config.js";
import { buildCronTools, type ToolDef } from "./tools/cron.js";
import { buildCronTemplateTools } from "./tools/cronTemplates.js";
import { buildDeviceTools } from "./tools/device.js";
import { buildDoctorTools } from "./tools/doctor.js";
import { buildExecApprovalTools } from "./tools/execApproval.js";
import { buildIntrospectTools } from "./tools/introspect.js";
import { buildLogsTools } from "./tools/logs.js";
import { buildModelsTools } from "./tools/models.js";
import { buildNodeTools } from "./tools/node.js";
import { buildPluginApprovalTools } from "./tools/pluginApproval.js";
import { buildSecretsTools } from "./tools/secrets.js";
import { buildSessionsTools } from "./tools/sessions.js";
import { buildSetupTools } from "./tools/setup.js";
import { buildSkillsTools } from "./tools/skills.js";
import { buildStatusTools } from "./tools/status.js";
import { buildTalkTools } from "./tools/talk.js";
import { buildToolsCatalogTools } from "./tools/toolsCatalog.js";
import { buildTtsTools } from "./tools/tts.js";
import { buildUsageTools } from "./tools/usage.js";
import { buildVoicewakeTools } from "./tools/voicewake.js";
import { buildWizardTools } from "./tools/wizard.js";

const ENV_URL = process.env.OPENCLAW_GATEWAY_URL?.trim() || undefined;
const ENV_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
const ENV_PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
const TIMEOUT = process.env.OPENCLAW_TIMEOUT_MS ? Number(process.env.OPENCLAW_TIMEOUT_MS) : undefined;
const DEBUG = process.env.OPENCLAW_DEBUG === "1";
const MOCK_MODE =
  process.env.OPENCLAW_MOCK === "1" ||
  process.env.OPENCLAW_MOCK === "true" ||
  process.argv.includes("--mock");

function debug(msg: string) {
  if (DEBUG) process.stderr.write(`${msg}\n`);
}

const store = new Store();

// Client cache, one entry per named instance. When the user switches the
// default instance (or env-vars override), the corresponding entry is dropped
// so the next call re-handshakes with fresh credentials.
const clients = new Map<string, GatewayClient>();
// Tracks the resolved name of the most-recently-used client, for the no-arg
// shim helpers (getDevice, getLastHello, …).
let activeInstance: string | null = null;
const ENV_INSTANCE = "__env__";

async function ensureClient(instance?: string): Promise<{ client: GatewayClient; name: string }> {
  // Env wins per-field (since 0.6.2). When ENV_URL is unset we still load the
  // store to find the URL, but ENV_TOKEN / ENV_PASSWORD override the store
  // values when set — so `OPENCLAW_GATEWAY_TOKEN=… node …` does what users
  // expect even without ENV_URL alongside.
  let url = ENV_URL;
  let token = ENV_TOKEN;
  let password = ENV_PASSWORD;
  let resolvedName = ENV_INSTANCE;
  if (!url) {
    const { configs, defaultInstance } = await store.loadConfigs();
    resolvedName = instance ?? defaultInstance;
    const cfg = configs[resolvedName];
    if (!cfg?.gatewayUrl) {
      throw new Error(
        instance
          ? `OpenClaw instance '${instance}' is not configured. Use openclaw_setup({ instance: '${instance}', … }) to create it, or openclaw_setup_list to see what's available.`
          : "OpenClaw gateway not configured. Set OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_TOKEN env vars or call openclaw_setup({gatewayUrl, gatewayToken}) to persist a default instance.",
      );
    }
    url = cfg.gatewayUrl;
    // Merge per-field: env > store. Empty strings in the store are treated
    // as missing — see mergeCreds in src/gateway/store.ts.
    const merged = mergeCreds({ token, password }, cfg);
    token = merged.token;
    password = merged.password;
  }
  let client = clients.get(resolvedName);
  if (!client) {
    client = new GatewayClient({ url, token, password, timeoutMs: TIMEOUT, store, debug });
    clients.set(resolvedName, client);
  }
  activeInstance = resolvedName;
  return { client, name: resolvedName };
}

async function reconfigure(instance?: string) {
  if (instance == null) {
    // Drop everything — default for setup_clear with no arg.
    for (const c of clients.values()) await c.close().catch(() => {});
    clients.clear();
    activeInstance = null;
    return;
  }
  const c = clients.get(instance);
  if (c) {
    await c.close().catch(() => {});
    clients.delete(instance);
    if (activeInstance === instance) activeInstance = null;
  }
  // Also drop the env-var synthetic instance so it gets re-resolved next call.
  const envClient = clients.get(ENV_INSTANCE);
  if (envClient) {
    await envClient.close().catch(() => {});
    clients.delete(ENV_INSTANCE);
  }
}

function activeClient(): GatewayClient | null {
  if (!activeInstance) return null;
  return clients.get(activeInstance) ?? null;
}

/**
 * Resolve the cached client for a sync getter (getDevice / getLastHello / …).
 * Honours the env-var override (always wins) and falls back to whichever
 * instance was last activated by an async call. Returns null when nothing
 * has been initialised yet — sync getters have no way to trigger a connect,
 * so callers expect null safely.
 */
function clientForLookup(opts?: CallOpts): GatewayClient | null {
  // Env override always wins, regardless of the requested instance name.
  if (ENV_URL) return clients.get(ENV_INSTANCE) ?? null;
  if (opts?.instance) return clients.get(opts.instance) ?? null;
  return activeClient();
}

const mockGateway = MOCK_MODE ? new MockGateway() : null;

// In MOCK_MODE we never reach the real GatewayClient — every tool call is
// answered by the in-memory MockGateway. Sync getters return canned values so
// `openclaw_device_status`, `openclaw_health` etc. don't crash on null.
const MOCK_HELLO = {
  type: "hello",
  protocol: 3,
  server: { version: "mock-2026.0.0", connId: "mock-conn" },
  features: { methods: [] as string[], events: [] as string[] },
};

const clientShim: ToolClient = {
  request: (async (method: string, params: unknown, opts?: CallOpts) => {
    if (mockGateway) return mockGateway.request(method, params);
    const { client: c } = await ensureClient(opts?.instance);
    return c.request(method, params);
  }) as ToolClient["request"],
  connect: async (opts) => {
    if (mockGateway) return MOCK_HELLO;
    const { client: c } = await ensureClient(opts?.instance);
    return c.connect();
  },
  close: async (opts) => {
    if (mockGateway) return;
    const c = clientForLookup(opts);
    if (c) await c.close();
  },
  getDevice: (opts) => {
    if (mockGateway) return { deviceId: "mock-device-id", publicKey: "mock", privateKey: "mock" };
    return clientForLookup(opts)?.getDevice() ?? null;
  },
  getLastHello: (opts) => {
    if (mockGateway) return MOCK_HELLO;
    return clientForLookup(opts)?.getLastHello() ?? null;
  },
  getPairingPending: (opts) => {
    if (mockGateway) return null;
    return clientForLookup(opts)?.getPairingPending() ?? null;
  },
  getGatewayId: (opts) => {
    if (mockGateway) return "mock-gateway";
    return clientForLookup(opts)?.getGatewayId() ?? "<unconfigured>";
  },
  getLastSuccessAtMs: (opts) => {
    if (mockGateway) return Date.now();
    return clientForLookup(opts)?.getLastSuccessAtMs() ?? null;
  },
};

const setupTools = buildSetupTools(store, {
  reconfigure: async (_cfg, instance) => {
    await reconfigure(instance);
  },
  envOverride: () => ({
    gatewayUrl: ENV_URL,
    tokenSet: !!ENV_TOKEN,
    passwordSet: !!ENV_PASSWORD,
  }),
});

const tools: ToolDef[] = [
  ...setupTools,
  ...buildDeviceTools(clientShim, store),
  ...buildIntrospectTools(clientShim, store),
  ...buildStatusTools(clientShim),
  ...buildSessionsTools(clientShim),
  ...buildChatTools(clientShim),
  ...buildLogsTools(clientShim),
  ...buildAgentsTools(clientShim),
  ...buildChannelsTools(clientShim),
  ...buildModelsTools(clientShim),
  ...buildUsageTools(clientShim),
  ...buildCronTools(clientShim),
  ...buildCronTemplateTools(clientShim),
  ...buildConfigTools(clientShim),
  ...buildSecretsTools(clientShim),
  ...buildSkillsTools(clientShim),
  ...buildToolsCatalogTools(clientShim),
  ...buildAdminTools(clientShim),
  ...buildExecApprovalTools(clientShim),
  ...buildPluginApprovalTools(clientShim),
  ...buildWizardTools(clientShim),
  ...buildDoctorTools(clientShim),
  ...buildNodeTools(clientShim),
  ...buildTtsTools(clientShim),
  ...buildTalkTools(clientShim),
  ...buildVoicewakeTools(clientShim),
];
const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "openclaw-control-mcp", version: getMcpVersion() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = toolMap.get(req.params.name);
  if (!tool) {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    throw new Error(`invalid arguments for ${tool.name}: ${parsed.error.message}`);
  }
  const result = await tool.handler(parsed.data);
  return {
    content: [
      {
        type: "text" as const,
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
});

async function shutdown() {
  for (const c of clients.values()) await c.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// CLI flag: `npx -y openclaw-control-mcp --health` runs a one-shot diagnostic
// then exits — does NOT start a server. Useful for `is everything OK?`
// without wiring the MCP into a client.
if (process.argv.includes("--health") || process.argv.includes("-H")) {
  const report = await runHealthDiagnostic();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}

const httpMode =
  process.argv.includes("--http") ||
  process.env.OPENCLAW_HTTP === "1" ||
  process.env.OPENCLAW_HTTP === "true";

if (httpMode) {
  await startHttpServer();
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("openclaw-control-mcp connected via stdio");
}

async function startHttpServer(): Promise<void> {
  const port = readNumberArg("--http-port", "OPENCLAW_HTTP_PORT") ?? 3333;
  const host = readStringArg("--http-host", "OPENCLAW_HTTP_HOST") ?? "127.0.0.1";
  const bearer = readStringArg("--http-bearer", "OPENCLAW_HTTP_BEARER");
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

  // Refuse to listen on a non-loopback interface without a bearer token —
  // the HTTP surface invokes every tool, including secrets.* writes, and an
  // unauthenticated server bound to 0.0.0.0 is an instant takeover.
  if (!bearer && !isLoopback) {
    process.stderr.write(
      `refusing to listen on ${host}:${port} without OPENCLAW_HTTP_BEARER set — public binding requires auth.\n` +
        `  set OPENCLAW_HTTP_BEARER=<long-random-string>, or bind to 127.0.0.1 to disable the check.\n`,
    );
    process.exit(1);
  }
  if (!bearer) {
    process.stderr.write(
      "WARNING: HTTP server starting without OPENCLAW_HTTP_BEARER. Loopback-only, but any local process can invoke tools.\n",
    );
  }

  // Stateful mode — assigns a session id per client so concurrent MCP clients
  // (Cursor + Continue + curl smoke-tests) don't share state. Stateless single
  // transport would force them to clobber each other on session-bound calls.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createHttpServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("missing url");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? host}`);
    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("not found — POST/GET /mcp for MCP traffic");
      return;
    }
    if (bearer) {
      const header = req.headers.authorization;
      if (!checkBearer(bearer, header)) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Bearer realm="openclaw-control-mcp"');
        res.end("unauthorized");
        return;
      }
    }
    transport.handleRequest(req, res).catch((err: unknown) => {
      debug(`http request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal error");
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  process.stderr.write(
    `openclaw-control-mcp listening on http://${host}:${port}/mcp (Streamable HTTP, MCP ${getMcpVersion()}, bearer-auth=${bearer ? "on" : "off"})\n`,
  );

  const closeHttp = async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await transport.close();
  };
  process.on("SIGINT", () => {
    closeHttp().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    closeHttp().finally(() => process.exit(0));
  });
}

/**
 * Constant-time bearer check. Returns false for any malformed/missing header.
 * `crypto.timingSafeEqual` requires equal-length buffers so a length mismatch
 * is checked first — that's still safe because the attacker can't time-probe
 * the *secret* length, only their own guess.
 */
export function checkBearer(expected: string, header: string | undefined): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readStringArg(flag: string, envName: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (idx >= 0) {
    const arg = process.argv[idx] ?? "";
    if (arg.includes("=")) return arg.split("=", 2)[1];
    return process.argv[idx + 1];
  }
  return process.env[envName]?.trim() || undefined;
}

function readNumberArg(flag: string, envName: string): number | undefined {
  const raw = readStringArg(flag, envName);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function runHealthDiagnostic() {
  const cfg = await store.loadConfig();
  const url = ENV_URL ?? cfg.gatewayUrl ?? null;
  const tokenSet = !!(ENV_TOKEN ?? cfg.gatewayToken);
  const result: {
    ok: boolean;
    mcpVersion: string;
    gatewayUrl: string | null;
    tokenSet: boolean;
    secretsLocation: string;
    paired: boolean;
    scopes: string[];
    server: { version?: string; connId?: string } | null;
    device: { fingerprint: string } | null;
    lastSuccessAgo: string | null;
    error: string | null;
  } = {
    ok: false,
    mcpVersion: getMcpVersion(),
    gatewayUrl: url,
    tokenSet,
    secretsLocation: await store.secretsLocation(),
    paired: false,
    scopes: [],
    server: null,
    device: null,
    lastSuccessAgo: null,
    error: null,
  };
  if (mockGateway) {
    // In mock mode there's no real handshake to probe — return a canned
    // successful health so the diagnostic exits 0 and tells the user clearly.
    result.ok = true;
    result.gatewayUrl = "mock://in-memory";
    result.paired = true;
    result.scopes = ["operator.read", "operator.write", "operator.admin"];
    result.server = MOCK_HELLO.server;
    result.device = { fingerprint: "mock-device-id  " };
    result.lastSuccessAgo = "0ms ago (mock)";
    return result;
  }
  if (!url) {
    result.error = "OpenClaw gateway not configured. Set OPENCLAW_GATEWAY_URL/TOKEN or run openclaw_setup once.";
    return result;
  }
  try {
    const { client: c } = await ensureClient();
    await c.connect();
    await c.request("health", {});
    const hello = c.getLastHello();
    const device = c.getDevice();
    const tokenEntry = await store.loadToken(c.getGatewayId());
    result.ok = true;
    result.paired = !!(tokenEntry && hello);
    result.scopes = tokenEntry?.scopes ?? [];
    result.server = hello?.server ?? null;
    result.device = device ? { fingerprint: device.deviceId.slice(0, 16) } : null;
    result.lastSuccessAgo = formatAgo(c.getLastSuccessAtMs());
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
