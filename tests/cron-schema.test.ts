import { describe, expect, it } from "vitest";
import { buildCronTools } from "../src/tools/cron.js";
import type { GatewayClient } from "../src/gateway/client.js";

const dummyClient = {} as GatewayClient;
const tools = buildCronTools(dummyClient);
const cronAdd = tools.find((t) => t.name === "openclaw_cron_add")!;
const cronUpdate = tools.find((t) => t.name === "openclaw_cron_update")!;
const cronRuns = tools.find((t) => t.name === "openclaw_cron_runs")!;
const cronList = tools.find((t) => t.name === "openclaw_cron_list")!;

describe("cron.add schema (wire format)", () => {
  it("accepts the `expr`/`tz` shape for kind='cron' (matches gateway)", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "spartners-veille-monitor",
        enabled: true,
        schedule: { kind: "cron", expr: "0 13 * * 5", tz: "Europe/Paris" },
        payload: {
          kind: "agentTurn",
          message: "Check the spartners run.",
          timeoutSeconds: 180,
        },
        delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts `everyMs` for kind='every'", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "ping",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "ping" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts `at` for kind='exact'", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "one-shot",
        schedule: { kind: "exact", at: "2026-12-31T23:59:00Z" },
        payload: { kind: "systemEvent", text: "year-end" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty job.name (min 1 char)", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "",
        schedule: { kind: "cron", expr: "0 9 * * 1" },
        payload: { kind: "agentTurn", message: "x" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown schedule.kind", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "x",
        schedule: { kind: "weird" },
        payload: { kind: "agentTurn", message: "y" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("passthrough lets unknown fields ride along", () => {
    const result = cronAdd.inputSchema.safeParse({
      job: {
        name: "x",
        schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Europe/Paris", customField: 42 },
        payload: { kind: "agentTurn", message: "y", futureFlag: true },
        someTopLevelExtension: "ok",
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("cron.update schema", () => {
  it("requires job.id", () => {
    const result = cronUpdate.inputSchema.safeParse({
      job: {
        enabled: false,
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update (only id + enabled)", () => {
    const result = cronUpdate.inputSchema.safeParse({
      job: {
        id: "5d3cda79-d870-40a9-9c86-316940d41d4e",
        enabled: false,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("cron.runs schema", () => {
  it("accepts compact + summaryMaxChars", () => {
    const result = cronRuns.inputSchema.safeParse({
      id: "abc",
      limit: 10,
      compact: true,
      summaryMaxChars: 500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative summaryMaxChars", () => {
    const result = cronRuns.inputSchema.safeParse({
      id: "abc",
      summaryMaxChars: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("cron.list schema", () => {
  it("accepts the four enabled-filter values", () => {
    for (const v of [undefined, "all", "enabled", "disabled"] as const) {
      const result = cronList.inputSchema.safeParse(v === undefined ? {} : { enabled: v });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown enabled value", () => {
    const result = cronList.inputSchema.safeParse({ enabled: "bogus" });
    expect(result.success).toBe(false);
  });
});
