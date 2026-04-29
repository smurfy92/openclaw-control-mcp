#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { formatAgo } from "./format.js";
import { GatewayClient } from "./gateway/client.js";
import { Store } from "./gateway/store.js";
import { getMcpVersion } from "./version.js";
import { buildAdminTools } from "./tools/admin.js";
import { buildAgentsTools } from "./tools/agents.js";
import { buildChannelsTools } from "./tools/channels.js";
import { buildChatTools } from "./tools/chat.js";
import { buildConfigTools } from "./tools/config.js";
import { buildCronTools, type ToolDef } from "./tools/cron.js";
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
  // Env-var override is treated as a synthetic "__env__" instance — wins when set.
  let url = ENV_URL;
  let token = ENV_TOKEN;
  let password = ENV_PASSWORD;
  let resolvedName = ENV_INSTANCE;
  if (url) {
    // Use env vars regardless of `instance` param — env wins over store.
  } else {
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
    token = cfg.gatewayToken;
    password = cfg.gatewayPassword;
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

const clientShim: GatewayClient = {
  request: (async (method: string, params?: unknown) => {
    const { client: c } = await ensureClient();
    return c.request(method, params);
  }) as GatewayClient["request"],
  connect: (async () => {
    const { client: c } = await ensureClient();
    return c.connect();
  }) as GatewayClient["connect"],
  close: (async () => {
    const c = activeClient();
    if (c) await c.close();
  }) as GatewayClient["close"],
  getDevice: () => activeClient()?.getDevice() ?? null,
  getLastHello: () => activeClient()?.getLastHello() ?? null,
  getPairingPending: () => activeClient()?.getPairingPending() ?? null,
  getGatewayId: () => activeClient()?.getGatewayId() ?? "<unconfigured>",
  getLastSuccessAtMs: () => activeClient()?.getLastSuccessAtMs() ?? null,
} as unknown as GatewayClient;

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

const transport = new StdioServerTransport();

async function shutdown() {
  for (const c of clients.values()) await c.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// CLI flag: `npx -y openclaw-control-mcp --health` runs a one-shot diagnostic
// then exits — does NOT start the stdio server. Useful for `is everything OK?`
// without wiring the MCP into a client.
if (process.argv.includes("--health") || process.argv.includes("-H")) {
  const report = await runHealthDiagnostic();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}

await server.connect(transport);
debug("openclaw-control-mcp connected via stdio");

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
