import { z } from "zod";
import { splitInstance, withInstance, type ToolClient } from "./client.js";
import type { ToolDef } from "./cron.js";

const DAY_OF_WEEK = z.enum([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
]);
const DAY_TO_CRON: Record<z.infer<typeof DAY_OF_WEEK>, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const HOUR = z.number().int().min(0).max(23);
const MINUTE = z.number().int().min(0).max(59);

/**
 * Common delivery + payload base shared across all four templates. Pulled
 * once so each template just declares its schedule shape.
 */
const PAYLOAD_BASE = {
  message: z
    .string()
    .min(1)
    .describe("The text the agent receives at fire time. Used as the agentTurn `message` field."),
  agentId: z.string().optional().describe("Override the default agent. Defaults to gateway's default."),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(86400)
    .default(900)
    .describe("Hard cap for the agent run. Default 900s (15min) — enough for cold-start + non-trivial work."),
  model: z.string().optional().describe("Override the default model, e.g. 'claude-sonnet-4-6'."),
  channel: z
    .string()
    .optional()
    .describe("Delivery channel name (e.g. 'telegram', 'email', 'discord'). Omit to keep the result internal."),
  to: z
    .string()
    .optional()
    .describe("Channel-specific recipient (Telegram chat id, email address, Discord channel id, …). Required when `channel` is set."),
  deliveryMode: z
    .enum(["announce", "direct", "none"])
    .optional()
    .describe("'announce' broadcasts to channel; 'direct' DMs; 'none' keeps result internal. Defaults to 'announce' when channel is set."),
};

type PayloadCommon = {
  message: string;
  agentId?: string;
  timeoutSeconds: number;
  model?: string;
  channel?: string;
  to?: string;
  deliveryMode?: "announce" | "direct" | "none";
};

function buildJob(
  name: string,
  schedule: Record<string, unknown>,
  common: PayloadCommon,
  extras: { deleteAfterRun?: boolean } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: "agentTurn",
    message: common.message,
    timeoutSeconds: common.timeoutSeconds,
  };
  if (common.model) payload.model = common.model;
  if (common.agentId) payload.agentId = common.agentId;

  const job: Record<string, unknown> = {
    name,
    schedule,
    payload,
    enabled: true,
  };
  if (common.channel) {
    job.delivery = {
      mode: common.deliveryMode ?? "announce",
      channel: common.channel,
      ...(common.to ? { to: common.to } : {}),
    };
  }
  if (extras.deleteAfterRun) job.deleteAfterRun = true;
  return job;
}

/**
 * Quality-of-life shortcuts on top of `openclaw_cron_add`. Each template
 * synthesizes the wire-format `job` object so callers don't have to remember
 * the `schedule.kind` / `payload.kind` enums and the cron expression syntax.
 */
export function buildCronTemplateTools(client: ToolClient): ToolDef[] {
  const weekly: ToolDef = {
    name: "openclaw_cron_add_weekly",
    description:
      "Create a cron job that fires once a week at a fixed local time. Synthesizes a `cron`-kind schedule and an `agentTurn` payload, then calls `cron.add`. Pass `dayOfWeek` (mon..sun), `hour` (0-23), `minute` (0-59), `tz` (IANA, defaults to Europe/Paris), and `message`. Optional channel delivery: pass `channel` + `to`.",
    inputSchema: withInstance(z.object({
      name: z.string().min(1).describe("Job name shown in the Control panel."),
      dayOfWeek: DAY_OF_WEEK.describe("Day of the week (lowercase 3-letter, e.g. 'fri')."),
      hour: HOUR.describe("Local hour (0-23)."),
      minute: MINUTE.default(0).describe("Local minute (0-59). Defaults to 0."),
      tz: z.string().default("Europe/Paris").describe("IANA timezone. Defaults to Europe/Paris."),
      ...PAYLOAD_BASE,
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as {
        name: string;
        dayOfWeek: z.infer<typeof DAY_OF_WEEK>;
        hour: number;
        minute: number;
        tz: string;
      } & PayloadCommon;
      const expr = `${a.minute} ${a.hour} * * ${DAY_TO_CRON[a.dayOfWeek]}`;
      const job = buildJob(
        a.name,
        { kind: "cron", expr, tz: a.tz },
        a,
      );
      return client.request("cron.add", { job }, opts);
    },
  };

  const daily: ToolDef = {
    name: "openclaw_cron_add_daily",
    description:
      "Create a cron job that fires every day at a fixed local time. Synthesizes the `cron`-kind schedule + `agentTurn` payload. Pass `hour`, `minute`, `tz`, `message`. Optional channel delivery via `channel` + `to`.",
    inputSchema: withInstance(z.object({
      name: z.string().min(1),
      hour: HOUR,
      minute: MINUTE.default(0),
      tz: z.string().default("Europe/Paris"),
      ...PAYLOAD_BASE,
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as {
        name: string;
        hour: number;
        minute: number;
        tz: string;
      } & PayloadCommon;
      const expr = `${a.minute} ${a.hour} * * *`;
      const job = buildJob(a.name, { kind: "cron", expr, tz: a.tz }, a);
      return client.request("cron.add", { job }, opts);
    },
  };

  const every: ToolDef = {
    name: "openclaw_cron_add_every",
    description:
      "Create a cron job that fires every N minutes/hours regardless of clock time. Synthesizes an `every`-kind schedule. Pass either `intervalMinutes` or `intervalHours` (the tool computes `everyMs`). Use for monitoring jobs that don't care about wall-clock alignment.",
    inputSchema: withInstance(z.object({
      name: z.string().min(1),
      intervalMinutes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Interval in minutes. Pass either this or intervalHours."),
      intervalHours: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Interval in hours. Pass either this or intervalMinutes."),
      ...PAYLOAD_BASE,
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as {
        name: string;
        intervalMinutes?: number;
        intervalHours?: number;
      } & PayloadCommon;
      let everyMs: number;
      if (a.intervalMinutes !== undefined) everyMs = a.intervalMinutes * 60_000;
      else if (a.intervalHours !== undefined) everyMs = a.intervalHours * 3_600_000;
      else throw new Error("openclaw_cron_add_every requires `intervalMinutes` or `intervalHours`.");
      if (everyMs < 60_000) {
        throw new Error("interval must be at least 1 minute (60000ms).");
      }
      const job = buildJob(a.name, { kind: "every", everyMs }, a);
      return client.request("cron.add", { job }, opts);
    },
  };

  const once: ToolDef = {
    name: "openclaw_cron_add_once",
    description:
      "Create a one-shot reminder/job that fires exactly once at a given absolute timestamp, then auto-deletes. Synthesizes an `exact`-kind schedule with `deleteAfterRun: true`. Pass `at` as RFC3339 (e.g. '2026-05-08T09:00:00+02:00') and a `message`.",
    inputSchema: withInstance(z.object({
      name: z.string().min(1),
      at: z
        .string()
        .min(10)
        .describe("RFC3339 timestamp, e.g. '2026-05-08T09:00:00+02:00' or '2026-05-08T07:00:00Z'."),
      ...PAYLOAD_BASE,
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as { name: string; at: string } & PayloadCommon;
      // Validate RFC3339 — Date.parse is permissive but rejects total garbage.
      if (Number.isNaN(Date.parse(a.at))) {
        throw new Error(`'at' is not a valid RFC3339 timestamp: ${a.at}`);
      }
      const job = buildJob(
        a.name,
        { kind: "exact", at: a.at },
        a,
        { deleteAfterRun: true },
      );
      return client.request("cron.add", { job }, opts);
    },
  };

  return [weekly, daily, every, once];
}
