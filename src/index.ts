#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayClient } from "./gateway/client.js";
import { Store } from "./gateway/store.js";
import { buildAgentsTools } from "./tools/agents.js";
import { buildChannelsTools } from "./tools/channels.js";
import { buildChatTools } from "./tools/chat.js";
import { buildCronTools, type ToolDef } from "./tools/cron.js";
import { buildDeviceTools } from "./tools/device.js";
import { buildIntrospectTools } from "./tools/introspect.js";
import { buildLogsTools } from "./tools/logs.js";
import { buildModelsTools } from "./tools/models.js";
import { buildSessionsTools } from "./tools/sessions.js";
import { buildSetupTools } from "./tools/setup.js";
import { buildStatusTools } from "./tools/status.js";
import { buildUsageTools } from "./tools/usage.js";

const ENV_URL = process.env.OPENCLAW_GATEWAY_URL?.trim() || undefined;
const ENV_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
const ENV_PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
const TIMEOUT = process.env.OPENCLAW_TIMEOUT_MS ? Number(process.env.OPENCLAW_TIMEOUT_MS) : undefined;
const DEBUG = process.env.OPENCLAW_DEBUG === "1";

function debug(msg: string) {
  if (DEBUG) process.stderr.write(`${msg}\n`);
}

const store = new Store();

let client: GatewayClient | null = null;

async function ensureClient(): Promise<GatewayClient> {
  if (client) return client;
  let url = ENV_URL;
  let token = ENV_TOKEN;
  let password = ENV_PASSWORD;
  if (!url) {
    const cfg = await store.loadConfig();
    url = cfg.gatewayUrl;
    token = token ?? cfg.gatewayToken;
    password = password ?? cfg.gatewayPassword;
  }
  if (!url) {
    throw new Error(
      "OpenClaw gateway not configured. Set OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_TOKEN env vars when launching this MCP, or call openclaw_setup({gatewayUrl, gatewayToken}) to persist them.",
    );
  }
  client = new GatewayClient({
    url,
    token,
    password,
    timeoutMs: TIMEOUT,
    store,
    debug,
  });
  return client;
}

async function reconfigure() {
  if (client) {
    await client.close();
    client = null;
  }
}

const clientShim: GatewayClient = {
  request: (async (method: string, params?: unknown) => {
    const c = await ensureClient();
    return c.request(method, params);
  }) as GatewayClient["request"],
  connect: (async () => {
    const c = await ensureClient();
    return c.connect();
  }) as GatewayClient["connect"],
  close: (async () => {
    if (client) await client.close();
  }) as GatewayClient["close"],
  getDevice: () => client?.getDevice() ?? null,
  getLastHello: () => client?.getLastHello() ?? null,
  getPairingPending: () => client?.getPairingPending() ?? null,
  getGatewayId: () => client?.getGatewayId() ?? "<unconfigured>",
} as unknown as GatewayClient;

const setupTools = buildSetupTools(store, {
  reconfigure: async () => {
    await reconfigure();
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
];
const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "openclaw-control-mcp", version: "0.2.0" },
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
  if (client) await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
debug("openclaw-control-mcp connected via stdio");
