import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { Store } from "../src/gateway/store.js";
import type { ToolDef } from "../src/tools/cron.js";
import { buildAdminTools } from "../src/tools/admin.js";
import { buildAgentsTools } from "../src/tools/agents.js";
import { buildChannelsTools } from "../src/tools/channels.js";
import { buildChatTools } from "../src/tools/chat.js";
import { buildConfigTools } from "../src/tools/config.js";
import { buildCronTools } from "../src/tools/cron.js";
import { buildCronTemplateTools } from "../src/tools/cronTemplates.js";
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
import { buildSetupTools } from "../src/tools/setup.js";
import { buildSkillsTools } from "../src/tools/skills.js";
import { buildStatusTools } from "../src/tools/status.js";
import { buildTalkTools } from "../src/tools/talk.js";
import { buildToolsCatalogTools } from "../src/tools/toolsCatalog.js";
import { buildTtsTools } from "../src/tools/tts.js";
import { buildUsageTools } from "../src/tools/usage.js";
import { buildVoicewakeTools } from "../src/tools/voicewake.js";
import { buildWizardTools } from "../src/tools/wizard.js";
import { makeMockClient } from "./helpers/mock-client.js";

/**
 * Aggregate every tool exposed by every builder, exactly the way index.ts does
 * at startup. If a new tool category is added, register it here too — the
 * collisions test below will catch the mistake of forgetting to register it
 * in index.ts (different failure mode, same root cause).
 */
function buildAllTools(): ToolDef[] {
  const { client } = makeMockClient();
  const store = new Store("/tmp/__architectural-test__", "store.json", { keychain: null });
  const setupHooks = {
    reconfigure: async () => {},
    envOverride: () => ({ gatewayUrl: undefined, tokenSet: false, passwordSet: false }),
  };
  return [
    ...buildSetupTools(store, setupHooks),
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
    ...buildCronTemplateTools(client),
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
}

/**
 * The setup family configures the local store, not gateway-routed calls —
 * those tools don't need the per-call `instance` arg. Same for openclaw_call's
 * params being typed as record (instance is at the top level alongside).
 */
const TOOLS_EXEMPT_FROM_INSTANCE_ARG = new Set([
  "openclaw_setup",
  "openclaw_setup_show",
  "openclaw_setup_list",
  "openclaw_setup_select_default",
  "openclaw_setup_clear",
]);

const tools = buildAllTools();

describe("architectural — all tools registered", () => {
  it("returns at least 140 tools (sanity)", () => {
    expect(tools.length).toBeGreaterThanOrEqual(140);
  });

  it("every tool name follows the openclaw_* convention", () => {
    // Allow camelCase tails (e.g. openclaw_tts_setProvider) so the names can
    // mirror JSON-RPC methods that themselves use camelCase
    // (`tts.setProvider`, `doctor.memory.dreamDiary`, …).
    const offenders = tools.filter((t) => !/^openclaw_[a-zA-Z][a-zA-Z0-9_]*$/.test(t.name));
    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  it("no two tools share a name", () => {
    const seen = new Map<string, number>();
    for (const t of tools) {
      seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([_, n]) => n > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
  });

  it("every tool has a non-empty description", () => {
    const offenders = tools.filter((t) => !t.description || t.description.length < 20);
    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  it("every gateway-routed tool accepts an optional `instance` field (withInstance)", () => {
    const offenders: string[] = [];
    for (const t of tools) {
      if (TOOLS_EXEMPT_FROM_INSTANCE_ARG.has(t.name)) continue;
      // The schema must validate `{ instance: "x" }` as a STRING value.
      const schema = t.inputSchema as ZodTypeAny;
      // We try a schema with required fields stubbed loosely. If even the
      // structural `instance: "x"` parse fails for non-instance reasons, we
      // skip — the goal is to verify `instance` is a known optional field.
      // We use `_def.shape()` indirection via parsing a wide attempt.
      const probe = (schema as z.ZodObject<z.ZodRawShape>)?._def?.shape?.();
      if (!probe || typeof probe !== "object") {
        offenders.push(`${t.name} (not a ZodObject root, can't introspect)`);
        continue;
      }
      if (!("instance" in probe)) {
        offenders.push(`${t.name} (no 'instance' field — wrap with withInstance())`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every handler is an async function", () => {
    const offenders: string[] = [];
    for (const t of tools) {
      // Async functions are detected by their string representation starting
      // with "async" (TypeScript-emitted) or having Symbol.asyncIterator-like
      // markers. The simplest reliable check: invoke with a no-arg attempt
      // and assert the return is a Promise.
      const result = (() => {
        try {
          return t.handler({});
        } catch {
          return null;
        }
      })();
      if (!(result instanceof Promise)) {
        offenders.push(t.name);
      } else {
        // Swallow the promise to avoid unhandled-rejection warnings.
        result.catch(() => {});
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("architectural — instance arg passes through correctly", () => {
  it("a sample of gateway-routed tools forward `instance` to client.request opts", async () => {
    // Build a fresh set with a captured stub so we can inspect calls.
    const { client, calls } = makeMockClient();
    const store = new Store("/tmp/__architectural-test-2__", "store.json", { keychain: null });
    const sample = [
      ...buildCronTools(client),
      ...buildSessionsTools(client),
      ...buildAgentsTools(client),
      ...buildLogsTools(client),
    ];

    const passthroughTools = [
      "openclaw_cron_list",
      "openclaw_cron_status",
      "openclaw_sessions_list",
      "openclaw_sessions_preview",
      "openclaw_agents_list",
      "openclaw_logs_tail",
    ];

    for (const name of passthroughTools) {
      const t = sample.find((x) => x.name === name);
      if (!t) throw new Error(`tool ${name} not found in sample`);
      const args =
        name === "openclaw_sessions_preview"
          ? { keys: ["agent:main:main"], instance: "work" }
          : { instance: "work" };
      const parsed = t.inputSchema.safeParse(args);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      await t.handler(parsed.data);
    }

    // Every captured call should have opts.instance === "work"
    const offenders = calls.filter((c) => c.opts?.instance !== "work");
    expect(offenders.map((c) => c.method)).toEqual([]);
  });
});
