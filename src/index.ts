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
import { buildCronTools, type ToolDef } from "./tools/cron.js";
import { buildDeviceTools } from "./tools/device.js";

const URL = process.env.OPENCLAW_GATEWAY_URL;
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD;
const TIMEOUT = process.env.OPENCLAW_TIMEOUT_MS ? Number(process.env.OPENCLAW_TIMEOUT_MS) : undefined;
const DEBUG = process.env.OPENCLAW_DEBUG === "1";

function debug(msg: string) {
  if (DEBUG) process.stderr.write(`${msg}\n`);
}

if (!URL) {
  process.stderr.write(
    "ERROR: OPENCLAW_GATEWAY_URL is required (e.g. ws://127.0.0.1:18789).\n" +
      "Extract it from the Control panel localStorage: openclaw.control.settings.v1 -> gatewayUrl.\n",
  );
  process.exit(1);
}

const store = new Store();
const client = new GatewayClient({
  url: URL,
  token: TOKEN,
  password: PASSWORD,
  timeoutMs: TIMEOUT,
  store,
  debug,
});

const tools: ToolDef[] = [...buildDeviceTools(client, store), ...buildCronTools(client)];
const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "openclaw-claw-mcp", version: "0.1.0" },
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
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
debug("openclaw-claw-mcp connected via stdio");
