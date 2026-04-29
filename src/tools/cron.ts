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
      "Create a new OpenClaw cron job. Wraps `cron.add`. Field names match the gateway wire format (verified by the Control panel SPA + live calls), NOT the README placeholders sometimes seen in the MCP source: schedule uses `expr`/`tz` (cron) or `everyMs` (every) or `at` (exact); payload.agentTurn uses `message` and `timeoutSeconds`. Examples: `{ schedule: { kind: \"cron\", expr: \"0 13 * * 5\", tz: \"Europe/Paris\" }, payload: { kind: \"agentTurn\", message: \"...\", timeoutSeconds: 180 } }`.",
    inputSchema: z.object({
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
              // agentTurn shape (matches monthly-token-report, spartners-veille-prospects, etc.)
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
