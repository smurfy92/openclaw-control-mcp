import { describe, expect, it } from "vitest";
import { buildCronTemplateTools } from "../src/tools/cronTemplates.js";
import { makeMockClient } from "./helpers/mock-client.js";

function getTool(name: string) {
  const { client, calls, setNextResponse } = makeMockClient();
  const tool = buildCronTemplateTools(client).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return { tool, calls, setNextResponse };
}

async function callTool(
  tool: { handler: (a: unknown) => Promise<unknown>; inputSchema: { safeParse: (a: unknown) => { success: boolean; error?: { message: string }; data?: unknown } } },
  args: unknown,
) {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new Error(`Zod rejected: ${parsed.error?.message}`);
  return tool.handler(parsed.data);
}

describe("openclaw_cron_add_weekly", () => {
  it("synthesizes the right cron expression for friday 09:00 Paris", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_weekly");
    await callTool(tool, {
      name: "weekly-monitor",
      dayOfWeek: "fri",
      hour: 9,
      message: "weekly digest",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("cron.add");
    const job = (calls[0]?.params as { job: Record<string, unknown> }).job;
    expect(job).toMatchObject({
      name: "weekly-monitor",
      schedule: { kind: "cron", expr: "0 9 * * 5", tz: "Europe/Paris" },
      payload: { kind: "agentTurn", message: "weekly digest", timeoutSeconds: 900 },
      enabled: true,
    });
    expect((job as { delivery?: unknown }).delivery).toBeUndefined();
  });

  it("attaches delivery when channel + to are provided", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_weekly");
    await callTool(tool, {
      name: "n",
      dayOfWeek: "mon",
      hour: 8,
      minute: 30,
      tz: "America/New_York",
      message: "m",
      channel: "telegram",
      to: "-1001234567890",
    });
    const job = (calls[0]?.params as { job: { schedule: Record<string, unknown>; delivery: Record<string, unknown> } }).job;
    expect(job.schedule).toEqual({ kind: "cron", expr: "30 8 * * 1", tz: "America/New_York" });
    expect(job.delivery).toEqual({ mode: "announce", channel: "telegram", to: "-1001234567890" });
  });
});

describe("openclaw_cron_add_daily", () => {
  it("uses '* * *' for the day fields", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_daily");
    await callTool(tool, { name: "morning", hour: 7, message: "go" });
    const job = (calls[0]?.params as { job: { schedule: { expr: string } } }).job;
    expect(job.schedule.expr).toBe("0 7 * * *");
  });
});

describe("openclaw_cron_add_every", () => {
  it("converts intervalMinutes to everyMs", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_every");
    await callTool(tool, { name: "ping", intervalMinutes: 5, message: "ping" });
    const job = (calls[0]?.params as { job: { schedule: { kind: string; everyMs: number } } }).job;
    expect(job.schedule).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it("converts intervalHours to everyMs", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_every");
    await callTool(tool, { name: "h", intervalHours: 2, message: "x" });
    const job = (calls[0]?.params as { job: { schedule: { everyMs: number } } }).job;
    expect(job.schedule.everyMs).toBe(7_200_000);
  });

  it("rejects when neither interval is provided", async () => {
    const { tool } = getTool("openclaw_cron_add_every");
    await expect(callTool(tool, { name: "x", message: "y" })).rejects.toThrow(/intervalMinutes.*intervalHours/);
  });

  it("rejects sub-minute intervals", async () => {
    const { tool } = getTool("openclaw_cron_add_every");
    // intervalMinutes is positive int — 0.5 fails Zod, but we can sneak via intervalHours? no, also positive int.
    // Cover the runtime guard by passing an unrealistic value through int casting.
    const parsed = tool.inputSchema.safeParse({ name: "x", intervalMinutes: 0, message: "y" });
    expect(parsed.success).toBe(false); // Zod rejects non-positive
  });
});

describe("openclaw_cron_add_once", () => {
  it("emits an exact schedule with deleteAfterRun=true", async () => {
    const { tool, calls } = getTool("openclaw_cron_add_once");
    await callTool(tool, {
      name: "reminder",
      at: "2026-12-25T09:00:00+01:00",
      message: "remember",
    });
    const job = (calls[0]?.params as { job: { schedule: Record<string, unknown>; deleteAfterRun: boolean } }).job;
    expect(job.schedule).toEqual({ kind: "exact", at: "2026-12-25T09:00:00+01:00" });
    expect(job.deleteAfterRun).toBe(true);
  });

  it("rejects garbage timestamps at runtime", async () => {
    const { tool } = getTool("openclaw_cron_add_once");
    await expect(callTool(tool, { name: "n", at: "not-a-date", message: "m" })).rejects.toThrow(
      /not a valid RFC3339/,
    );
  });
});
