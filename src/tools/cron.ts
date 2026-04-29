import { z } from "zod";
import type { GatewayClient } from "../gateway/client.js";
import { formatAgo, truncate } from "../format.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<unknown>;
};

const enabledFilter = z.enum(["all", "enabled", "disabled"]).optional();

export function buildCronTools(client: GatewayClient): ToolDef[] {
  const cronList: ToolDef = {
    name: "openclaw_cron_list",
    description:
      "List configured OpenClaw cron jobs. Wraps the gateway JSON-RPC method `cron.list`. Returns jobs with name, schedule, payload kind, and enabled state.",
    inputSchema: z.object({
      query: z.string().optional().describe("Free-text search filter on job name"),
      enabled: enabledFilter.describe("Filter by enabled/disabled state"),
      includeDisabled: z.boolean().optional().describe("Set true to include disabled jobs (alias for enabled='all')"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      sortBy: z.string().optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    }),
    handler: async (args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      return client.request("cron.list", params);
    },
  };

  const cronStatus: ToolDef = {
    name: "openclaw_cron_status",
    description:
      "Get the OpenClaw cron scheduler status (enabled flag, next-run timestamp, recent failures). Wraps `cron.status`.",
    inputSchema: z.object({}),
    handler: async () => client.request("cron.status", {}),
  };

  const cronRun: ToolDef = {
    name: "openclaw_cron_run",
    description: "Trigger an immediate run of a specific OpenClaw cron job by id. Wraps `cron.run`.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Cron job id"),
    }),
    handler: async (args) => client.request("cron.run", args ?? {}),
  };

  const cronRuns: ToolDef = {
    name: "openclaw_cron_runs",
    description:
      "List recent runs of a specific OpenClaw cron job. Wraps `cron.runs`. Pass `compact: true` to truncate each run's `summary` to 200 chars (saves tokens when scanning many runs); a `summaryTruncated` flag is added per entry. Each entry also gets a `runAtAgo` field (e.g. \"3h ago\") for readability.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Cron job id"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      compact: z.boolean().optional().describe("Truncate each run's summary to 200 chars"),
      summaryMaxChars: z.number().int().positive().max(5000).optional().describe("Override the truncation length when compact=true (default 200)"),
    }),
    handler: async (args) => {
      const opts = (args ?? {}) as {
        compact?: boolean;
        summaryMaxChars?: number;
        [k: string]: unknown;
      };
      const { compact, summaryMaxChars, ...rpcArgs } = opts;
      const max = summaryMaxChars ?? 200;
      const result = (await client.request("cron.runs", rpcArgs)) as {
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
    inputSchema: z.object({
      id: z.string().min(1).describe("Cron job id"),
    }),
    handler: async (args) => client.request("cron.remove", args ?? {}),
  };

  const cronAdd: ToolDef = {
    name: "openclaw_cron_add",
    description:
      "Create a new OpenClaw cron job. Wraps `cron.add`. The `job` payload mirrors the Control panel form: name, schedule (every / cron expr), payload kind (agentTurn/systemEvent), delivery target.",
    inputSchema: z.object({
      job: z
        .object({
          name: z.string().min(1),
          id: z.string().optional(),
          schedule: z
            .object({
              kind: z.enum(["every", "cron", "exact"]),
              cronExpr: z.string().optional(),
              cronTz: z.string().optional(),
              everyAmount: z.number().int().positive().optional(),
              everyUnit: z.enum(["seconds", "minutes", "hours", "days"]).optional(),
              scheduleAt: z.string().optional(),
            })
            .passthrough(),
          payload: z
            .object({
              kind: z.enum(["agentTurn", "systemEvent"]),
              text: z.string().optional(),
              model: z.string().optional(),
              thinking: z.string().optional(),
              lightContext: z.boolean().optional(),
            })
            .passthrough(),
          delivery: z
            .object({
              mode: z.enum(["announce", "direct", "none"]).optional(),
              channel: z.string().optional(),
              to: z.string().optional(),
              accountId: z.string().optional(),
            })
            .passthrough()
            .optional(),
          enabled: z.boolean().optional(),
          deleteAfterRun: z.boolean().optional(),
        })
        .passthrough(),
    }),
    handler: async (args) => client.request("cron.add", args ?? {}),
  };

  const cronUpdate: ToolDef = {
    name: "openclaw_cron_update",
    description:
      "Update an existing OpenClaw cron job in place. Wraps `cron.update`. Avoids the remove + re-add dance when you just want to change schedule, timeout, payload, or delivery. Pass the job id and the fields to change.",
    inputSchema: z.object({
      job: z
        .object({
          id: z.string().min(1).describe("Cron job id"),
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
        .passthrough(),
    }),
    handler: async (args) => client.request("cron.update", args ?? {}),
  };

  return [cronList, cronStatus, cronRun, cronRuns, cronRemove, cronAdd, cronUpdate];
}
