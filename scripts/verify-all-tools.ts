// Live regression guard: round-trip every read-only tool wrapper against the
// configured gateway, capture wrapper-level Zod validation + gateway-level
// INVALID_REQUEST responses, and emit a JSON report. Run before each release
// to catch the next schema-drift bug class as early as possible.
//
// Usage:
//   npx tsx scripts/verify-all-tools.ts                 # human-readable summary
//   npx tsx scripts/verify-all-tools.ts --json          # JSON report on stdout
//   npx tsx scripts/verify-all-tools.ts --out report.json
//
// Filters: --include cron,sessions,config (substring match on tool name)
//          --exclude doctor,wizard
//
// Env: same as the MCP itself (OPENCLAW_GATEWAY_URL/TOKEN, OPENCLAW_TIMEOUT_MS).
//      OPENCLAW_DEBUG=1 to log every WS frame.

import { writeFile } from "node:fs/promises";
import { GatewayClient } from "../src/gateway/client.js";
import { mergeCreds, Store } from "../src/gateway/store.js";
import type { CallOpts, ToolClient } from "../src/tools/client.js";
import type { ToolDef } from "../src/tools/cron.js";
import { buildAdminTools } from "../src/tools/admin.js";
import { buildAgentsTools } from "../src/tools/agents.js";
import { buildChannelsTools } from "../src/tools/channels.js";
import { buildChatTools } from "../src/tools/chat.js";
import { buildConfigTools } from "../src/tools/config.js";
import { buildCronTools } from "../src/tools/cron.js";
import { buildDeviceTools } from "../src/tools/device.js";
import { buildDoctorTools } from "../src/tools/doctor.js";
import { buildExecApprovalTools } from "../src/tools/execApproval.js";
import { buildIntrospectTools } from "../src/tools/introspect.js";
import { buildLogsTools } from "../src/tools/logs.js";
import { buildModelsTools } from "../src/tools/models.js";
import { buildNodeTools } from "../src/tools/node.js";
import { buildPluginApprovalTools } from "../src/tools/pluginApproval.js";
import { buildSecretsTools } from "../src/tools/secrets.js";
import { buildSessionsTools } from "../src/tools/sessions.js";
import { buildSkillsTools } from "../src/tools/skills.js";
import { buildStatusTools } from "../src/tools/status.js";
import { buildTalkTools } from "../src/tools/talk.js";
import { buildToolsCatalogTools } from "../src/tools/toolsCatalog.js";
import { buildTtsTools } from "../src/tools/tts.js";
import { buildUsageTools } from "../src/tools/usage.js";
import { buildVoicewakeTools } from "../src/tools/voicewake.js";
import { buildWizardTools } from "../src/tools/wizard.js";

type Outcome = {
  tool: string;
  method: string | null;
  status: "ok" | "wrapper-zod-error" | "gateway-invalid-request" | "gateway-other-error" | "skipped";
  args: Record<string, unknown>;
  errorMessage?: string;
  errorCode?: string;
  responseSnippet?: string;
};

/**
 * Read-only or no-side-effect calls the probe knows how to invoke safely.
 * Each entry: tool name → args to pass to the wrapper. The wrapper validates
 * with Zod, then routes to the gateway. Both paths can fail and both are
 * captured. Mutating tools (cron.add/remove/update, sessions.delete, …) are
 * intentionally absent — schema drift in those is caught the same way by the
 * read-only equivalents in their domain (cron.list, sessions.list, …).
 */
const SAFE_PROBES: Array<{ name: string; args: Record<string, unknown> }> = [
  // status / health / identity
  { name: "openclaw_status", args: {} },
  { name: "openclaw_health", args: {} },
  { name: "openclaw_last_heartbeat", args: {} },
  { name: "openclaw_system_presence", args: {} },
  // openclaw_agent + openclaw_send are SEND-style (verified live) — skipped to
  // avoid triggering real agent turns / channel deliveries during a probe run.
  { name: "openclaw_agent_identity_get", args: {} },
  { name: "openclaw_gateway_identity_get", args: {} },
  // cron read
  { name: "openclaw_cron_list", args: {} },
  { name: "openclaw_cron_status", args: {} },
  // sessions read
  { name: "openclaw_sessions_list", args: {} },
  { name: "openclaw_sessions_list", args: { status: "running" } }, // client-side filter
  // agents read
  { name: "openclaw_agents_list", args: {} },
  // channels read
  { name: "openclaw_channels_status", args: {} },
  // models / usage
  { name: "openclaw_models_list", args: {} },
  { name: "openclaw_usage_status", args: {} },
  // config read (with and without path projection)
  { name: "openclaw_config_get", args: {} },
  { name: "openclaw_config_get", args: { path: "channels" } },
  { name: "openclaw_config_schema", args: {} },
  // logs (limit small)
  { name: "openclaw_logs_tail", args: { limit: 10 } },
  { name: "openclaw_logs_tail", args: { limit: 50, level: "ERROR" } },
  // skills
  { name: "openclaw_skills_status", args: {} },
  { name: "openclaw_skills_bins", args: {} },
  { name: "openclaw_skills_search", args: { limit: 5 } },
  // tools catalog
  { name: "openclaw_tools_catalog", args: {} },
  { name: "openclaw_tools_catalog", args: { agentId: "main" } },
  // chat history (read-only) — keyed by sessionKey
  { name: "openclaw_chat_history", args: { sessionKey: "agent:main:main", limit: 5 } },
  // exec approvals
  { name: "openclaw_exec_approval_list", args: {} },
  { name: "openclaw_exec_approvals_get", args: {} },
  // plugin approvals
  { name: "openclaw_plugin_approval_list", args: {} },
  // wizard — requires sessionId (verified live)
  { name: "openclaw_wizard_status", args: { sessionId: "agent:main:main" } },
  // doctor memory (read)
  { name: "openclaw_doctor_memory_status", args: {} },
  { name: "openclaw_doctor_memory_dreamDiary", args: { limit: 5 } },
  // node
  { name: "openclaw_node_list", args: {} },
  { name: "openclaw_node_pair_list", args: {} },
  // device pair list (read, requires operator scope)
  { name: "openclaw_device_pair_list", args: {} },
  { name: "openclaw_device_status", args: {} },
  // introspect / coverage
  { name: "openclaw_introspect", args: {} },
  // commands list
  { name: "openclaw_commands_list", args: {} },
  // tts / talk / voicewake reads
  { name: "openclaw_tts_status", args: {} },
  { name: "openclaw_tts_providers", args: {} },
  { name: "openclaw_talk_config", args: {} },
  { name: "openclaw_voicewake_get", args: {} },
  // config schema deep-dive
  { name: "openclaw_config_schema_lookup", args: { path: "channels" } },
  { name: "openclaw_config_get", args: { path: "agents.defaults" } },
  // cost (read-only billing)
  { name: "openclaw_usage_cost", args: {} },
  // sessions read (preview a known session — read-only)
  { name: "openclaw_sessions_preview", args: { keys: ["agent:main:main"] } },
];

function buildAllTools(client: ToolClient, store: Store): Map<string, ToolDef> {
  const all: ToolDef[] = [
    ...buildDeviceTools(client, store),
    ...buildIntrospectTools(client, store),
    ...buildStatusTools(client),
    ...buildSessionsTools(client),
    ...buildChatTools(client),
    ...buildLogsTools(client),
    ...buildAgentsTools(client),
    ...buildChannelsTools(client),
    ...buildModelsTools(client),
    ...buildUsageTools(client),
    ...buildCronTools(client),
    ...buildConfigTools(client),
    ...buildSecretsTools(client),
    ...buildSkillsTools(client),
    ...buildToolsCatalogTools(client),
    ...buildAdminTools(client),
    ...buildExecApprovalTools(client),
    ...buildPluginApprovalTools(client),
    ...buildWizardTools(client),
    ...buildDoctorTools(client),
    ...buildNodeTools(client),
    ...buildTtsTools(client),
    ...buildTalkTools(client),
    ...buildVoicewakeTools(client),
  ];
  return new Map(all.map((t) => [t.name, t]));
}

function debug(msg: string) {
  if (process.env.OPENCLAW_DEBUG === "1") process.stderr.write(`${msg}\n`);
}

function parseArgsCli(): { json: boolean; out: string | null; include: string[]; exclude: string[] } {
  const a = process.argv.slice(2);
  const out: { json: boolean; out: string | null; include: string[]; exclude: string[] } = {
    json: false,
    out: null,
    include: [],
    exclude: [],
  };
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? "";
    if (v === "--json") out.json = true;
    else if (v === "--out") out.out = a[++i] ?? null;
    else if (v === "--include") out.include = (a[++i] ?? "").split(",").filter(Boolean);
    else if (v === "--exclude") out.exclude = (a[++i] ?? "").split(",").filter(Boolean);
  }
  return out;
}

async function main() {
  const cli = parseArgsCli();
  const store = new Store();
  // Same resolution order as src/index.ts: env-only is enough (the runtime
  // path the MCP server takes when given OPENCLAW_GATEWAY_URL/TOKEN with no
  // on-disk store). Fall back to the persisted config when env is incomplete.
  const ENV_URL = process.env.OPENCLAW_GATEWAY_URL?.trim() || undefined;
  const ENV_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const ENV_PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  let url = ENV_URL;
  let token = ENV_TOKEN;
  let password = ENV_PASSWORD;
  let gatewayUrlForReport = url;
  if (!url) {
    const cfg = await store.loadConfig();
    if (!cfg.gatewayUrl) {
      process.stderr.write(
        "no gateway configured — set OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_TOKEN or run openclaw_setup first\n",
      );
      process.exit(1);
    }
    url = cfg.gatewayUrl;
    const merged = mergeCreds({ token, password }, cfg);
    token = merged.token;
    password = merged.password;
    gatewayUrlForReport = url;
  }
  const real = new GatewayClient({
    url,
    token,
    password,
    store,
    debug,
  });
  await real.connect();

  // Capture each gateway request method made by a wrapper so we can attribute
  // outcomes to the right JSON-RPC call (some wrappers fire >1 request).
  let lastRequestedMethod: string | null = null;
  const client: ToolClient = {
    request: async (method: string, params, _opts?: CallOpts) => {
      lastRequestedMethod = method;
      return real.request(method, params);
    },
    connect: () => real.connect(),
    close: () => real.close(),
    getDevice: () => real.getDevice(),
    getLastHello: () => real.getLastHello() as never,
    getPairingPending: () => real.getPairingPending(),
    getGatewayId: () => real.getGatewayId(),
    getLastSuccessAtMs: () => real.getLastSuccessAtMs(),
  };

  const tools = buildAllTools(client, store);
  const outcomes: Outcome[] = [];

  // Filter probes
  const probes = SAFE_PROBES.filter((p) => {
    if (cli.include.length > 0 && !cli.include.some((s) => p.name.includes(s))) return false;
    if (cli.exclude.length > 0 && cli.exclude.some((s) => p.name.includes(s))) return false;
    return true;
  });

  for (const probe of probes) {
    const tool = tools.get(probe.name);
    if (!tool) {
      outcomes.push({
        tool: probe.name,
        method: null,
        status: "skipped",
        args: probe.args,
        errorMessage: "tool not registered",
      });
      continue;
    }

    const parsed = tool.inputSchema.safeParse(probe.args);
    if (!parsed.success) {
      outcomes.push({
        tool: probe.name,
        method: null,
        status: "wrapper-zod-error",
        args: probe.args,
        errorMessage: parsed.error.message,
      });
      continue;
    }

    lastRequestedMethod = null;
    try {
      const result = await tool.handler(parsed.data);
      outcomes.push({
        tool: probe.name,
        method: lastRequestedMethod,
        status: "ok",
        args: probe.args,
        responseSnippet: JSON.stringify(result).slice(0, 200),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isInvalidReq = /INVALID_REQUEST|invalid \w+\.\w+ params/i.test(msg);
      const code = (err as { code?: string }).code;
      outcomes.push({
        tool: probe.name,
        method: lastRequestedMethod,
        status: isInvalidReq ? "gateway-invalid-request" : "gateway-other-error",
        args: probe.args,
        errorMessage: msg.slice(0, 400),
        errorCode: code,
      });
    }
  }

  await real.close();

  // Summary
  const byStatus = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const drifts = outcomes.filter((o) => o.status === "gateway-invalid-request");

  const report = {
    generatedAt: new Date().toISOString(),
    gateway: { url: gatewayUrlForReport },
    summary: {
      totalProbes: outcomes.length,
      byStatus,
      driftCount: drifts.length,
    },
    drifts,
    outcomes,
  };

  if (cli.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`\n=== verify-all-tools — ${outcomes.length} probes against ${gatewayUrlForReport} ===\n`);
    for (const o of outcomes) {
      const icon =
        o.status === "ok"
          ? "✓"
          : o.status === "skipped"
            ? "·"
            : o.status === "gateway-invalid-request"
              ? "✗ DRIFT"
              : "✗";
      const args = Object.keys(o.args).length > 0 ? ` ${JSON.stringify(o.args)}` : "";
      process.stdout.write(`  ${icon} ${o.tool}${args}`);
      if (o.errorMessage) process.stdout.write(`  → ${o.errorMessage.slice(0, 120)}`);
      process.stdout.write("\n");
    }
    process.stdout.write("\nSummary:\n");
    for (const [k, v] of Object.entries(byStatus)) {
      process.stdout.write(`  ${k.padEnd(28)} ${v}\n`);
    }
    if (drifts.length > 0) {
      process.stdout.write(`\n⚠ ${drifts.length} schema drift(s) detected — wrapper(s) accept params the gateway rejects:\n`);
      for (const d of drifts) {
        process.stdout.write(`  - ${d.tool}${JSON.stringify(d.args)}\n    → ${d.errorMessage}\n`);
      }
      process.stdout.write("\nFix candidates:\n");
      process.stdout.write("  - Update the wrapper Zod schema to remove the rejected param.\n");
      process.stdout.write("  - Or apply client-side filtering (see existing patterns in sessions.list / config.get / logs.tail).\n");
      process.stdout.write("  - Document the new wire format in CHANGELOG under [Unreleased] > Fixed.\n");
    }
  }

  if (cli.out) {
    await writeFile(cli.out, JSON.stringify(report, null, 2), "utf8");
    process.stderr.write(`report written to ${cli.out}\n`);
  }

  // Exit code: non-zero if any drift was detected, so CI can gate on it.
  if (drifts.length > 0) process.exit(2);
}

await main();
