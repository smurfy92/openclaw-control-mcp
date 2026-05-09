import { z } from "zod";
import { passthroughHandler, splitInstance, withInstance, type ToolClient } from "./client.js";
import { formatAgo, truncate } from "../format.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<unknown>;
};

const enabledFilter = z.enum(["all", "enabled", "disabled"]).optional();

export function buildCronTools(client: ToolClient): ToolDef[] {
  const cronList: ToolDef = {
    name: "openclaw_cron_list",
    description:
      "List configured OpenClaw cron jobs. Wraps the gateway JSON-RPC method `cron.list`. Returns jobs with name, schedule, payload kind, and enabled state.",
    inputSchema: withInstance(z.object({
      query: z.string().optional().describe("Free-text search filter on job name"),
      enabled: enabledFilter.describe("Filter by enabled/disabled state"),
      includeDisabled: z.boolean().optional().describe("Set true to include disabled jobs (alias for enabled='all')"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      sortBy: z.string().optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    })),
    handler: passthroughHandler(client, "cron.list"),
  };

  const cronStatus: ToolDef = {
    name: "openclaw_cron_status",
    description:
      "Get the OpenClaw cron scheduler status (enabled flag, next-run timestamp, recent failures). Wraps `cron.status`.",
    inputSchema: withInstance(z.object({})),
    handler: passthroughHandler(client, "cron.status"),
  };

  const cronRun: ToolDef = {
    name: "openclaw_cron_run",
    description: "Trigger an immediate run of a specific OpenClaw cron job by id. Wraps `cron.run`.",
    inputSchema: withInstance(z.object({
      id: z.string().min(1).describe("Cron job id"),
    })),
    handler: passthroughHandler(client, "cron.run"),
  };

  const cronRuns: ToolDef = {
    name: "openclaw_cron_runs",
    description:
      "List recent runs of a specific OpenClaw cron job. Wraps `cron.runs`. Pass `compact: true` to truncate each run's `summary` to 200 chars (saves tokens when scanning many runs); a `summaryTruncated` flag is added per entry. Each entry also gets a `runAtAgo` field (e.g. \"3h ago\") for readability.",
    inputSchema: withInstance(z.object({
      id: z.string().min(1).describe("Cron job id"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      compact: z.boolean().optional().describe("Truncate each run's summary to 200 chars"),
      summaryMaxChars: z.number().int().positive().max(5000).optional().describe("Override the truncation length when compact=true (default 200)"),
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const { compact, summaryMaxChars, ...rpcArgs } = rest as {
        compact?: boolean;
        summaryMaxChars?: number;
        [k: string]: unknown;
      };
      const max = summaryMaxChars ?? 200;
      const result = (await client.request("cron.runs", rpcArgs, opts)) as {
        entries?: Array<Record<string, unknown>>;
        [k: string]: unknown;
      };
      const entries = Array.isArray(result?.entries) ? result.entries : null;
      if (!entries) return result;
      return {
        ...result,
        entries: entries.map((entry) => {
          const enriched: Record<string, unknown> = { ...entry };
          if (typeof entry.runAtMs === "number") enriched.runAtAgo = formatAgo(entry.runAtMs);
          if (compact && typeof entry.summary === "string") {
            const t = truncate(entry.summary, max);
            enriched.summary = t.value;
            enriched.summaryTruncated = t.truncated;
          }
          return enriched;
        }),
      };
    },
  };

  const cronRemove: ToolDef = {
    name: "openclaw_cron_remove",
    description: "Delete an OpenClaw cron job by id. Destructive — confirm before calling. Wraps `cron.remove`.",
    inputSchema: withInstance(z.object({
      id: z.string().min(1).describe("Cron job id"),
    })),
    handler: passthroughHandler(client, "cron.remove"),
  };

  const cronAdd: ToolDef = {
    name: "openclaw_cron_add",
    description:
      "Create a new OpenClaw cron job. Wraps `cron.add`. Field names match the gateway wire format (verified by the Control panel SPA + live calls), NOT the README placeholders sometimes seen in the MCP source: schedule uses `expr`/`tz` (cron) or `everyMs` (every) or `at` (exact); payload.agentTurn uses `message` and `timeoutSeconds`. Examples: `{ schedule: { kind: \"cron\", expr: \"0 13 * * 5\", tz: \"Europe/Paris\" }, payload: { kind: \"agentTurn\", message: \"...\", timeoutSeconds: 180 } }`.",
    inputSchema: withInstance(z.object({
      job: z
        .object({
          name: z.string().min(1).describe("Job name shown in the Control panel"),
          id: z.string().optional().describe("Optional explicit id; gateway generates one if omitted"),
          schedule: z
            .object({
              kind: z.enum(["every", "cron", "exact"]),
              // kind: "cron"
              expr: z.string().optional().describe("5-field cron expression, e.g. '0 9 * * 5'. Required when kind='cron'."),
              tz: z.string().optional().describe("IANA timezone, e.g. 'Europe/Paris'. Used with kind='cron'."),
              // kind: "every"
              everyMs: z.number().int().positive().optional().describe("Interval in milliseconds. Required when kind='every'."),
              // kind: "exact"
              at: z.string().optional().describe("RFC3339 timestamp. Required when kind='exact'."),
            })
            .passthrough(),
          payload: z
            .object({
              kind: z.enum(["agentTurn", "systemEvent"]),
              // agentTurn shape — sends `message` to the named agent at fire time.
              message: z.string().optional().describe("The text the agent receives at fire time. Used with kind='agentTurn'."),
              timeoutSeconds: z.number().int().positive().optional().describe("Hard cap for the agent run. Default agentic monitors should use ≥120s (cold-start ~10-15s)."),
              model: z.string().optional().describe("Override the default model for this job, e.g. 'claude-sonnet-4-6'."),
              // systemEvent shape
              text: z.string().optional().describe("Event text (used with kind='systemEvent' and a few internal agentTurn flavors)."),
              thinking: z.string().optional(),
              lightContext: z.boolean().optional(),
            })
            .passthrough(),
          delivery: z
            .object({
              mode: z.enum(["announce", "direct", "none"]).optional().describe("'announce' broadcasts to the configured channel; 'direct' sends as DM; 'none' keeps the result internal."),
              channel: z.string().optional().describe("Channel name, e.g. 'telegram', 'email', 'webchat'."),
              to: z.string().optional().describe("Channel-specific recipient, e.g. a Telegram chat id (-1001234567890) or an email address."),
              accountId: z.string().optional().describe("Channel account id when several are configured."),
            })
            .passthrough()
            .optional(),
          enabled: z.boolean().optional().describe("Default true if omitted."),
          deleteAfterRun: z.boolean().optional().describe("Self-delete after one fire — useful for one-shot reminders."),
        })
        .passthrough(),
    })),
    handler: passthroughHandler(client, "cron.add"),
  };

  const cronUpdate: ToolDef = {
    name: "openclaw_cron_update",
    description:
      "Update an existing OpenClaw cron job in place. Wraps `cron.update`. Avoids the remove + re-add dance when you just want to change schedule, timeout, payload, or delivery. Wire format (verified live against gateway 2026.4.12+): `{ id|jobId: string, patch: object }` — pass the job id and a `patch` object containing only the fields you want to change. Older shape `{ job: { id, ...fields } }` is auto-translated for backward compat with pre-0.5.1 callers.",
    inputSchema: withInstance(z.object({
      id: z.string().min(1).optional().describe("Cron job id (preferred). Pass either `id` or `jobId`."),
      jobId: z.string().min(1).optional().describe("Cron job id (alias). Pass either `id` or `jobId`."),
      patch: z
        .object({
          name: z.string().optional(),
          enabled: z.boolean().optional(),
          schedule: z
            .object({
              kind: z.enum(["every", "cron", "exact"]),
              expr: z.string().optional(),
              tz: z.string().optional(),
              everyMs: z.number().int().positive().optional(),
              at: z.string().optional(),
            })
            .passthrough()
            .optional(),
          payload: z
            .object({
              kind: z.enum(["agentTurn", "systemEvent"]),
              message: z.string().optional(),
              text: z.string().optional(),
              timeoutSeconds: z.number().int().positive().optional(),
              model: z.string().optional(),
            })
            .passthrough()
            .optional(),
          delivery: z
            .object({
              mode: z.enum(["announce", "direct", "none"]).optional(),
              channel: z.string().optional(),
              to: z.string().optional(),
            })
            .passthrough()
            .optional(),
          deleteAfterRun: z.boolean().optional(),
        })
        .passthrough()
        .optional()
        .describe("Fields to change (any subset of writable cron fields)."),
      // Backward-compat: pre-0.5.1 callers passed `{ job: { id, ...fields } }`.
      // We accept it and translate to the live wire format below.
      job: z
        .object({
          id: z.string().min(1),
        })
        .passthrough()
        .optional()
        .describe("DEPRECATED — pre-0.5.1 shape. Pass `id` + `patch` instead."),
    })),
    handler: async (args) => {
      const { rest, opts } = splitInstance(args);
      const a = rest as {
        id?: string;
        jobId?: string;
        patch?: Record<string, unknown>;
        job?: { id: string; [k: string]: unknown };
      };
      let id = a.id ?? a.jobId;
      let patch: Record<string, unknown> = a.patch ?? {};
      if (a.job) {
        const { id: legacyId, ...legacyPatch } = a.job;
        id = id ?? legacyId;
        patch = { ...legacyPatch, ...patch };
      }
      if (!id) {
        throw new Error("cron.update requires `id` (or legacy `job.id` / `jobId`).");
      }
      return client.request("cron.update", { id, patch }, opts);
    },
  };

  return [cronList, cronStatus, cronRun, cronRuns, cronRemove, cronAdd, cronUpdate];
}
