import { randomUUID } from "node:crypto";

/**
 * In-memory dry-run gateway. Activated with `OPENCLAW_MOCK=1` (or `--mock`).
 * Lets callers exercise the full MCP surface without provisioning a real
 * gateway — handy for CI, demos, and ad-hoc workflow rehearsals before
 * touching prod.
 *
 * Coverage is intentionally narrow: the methods most-used by the typed
 * wrappers (cron, sessions list/preview/create, config get/patch, status,
 * health, gateway.identity.get, agents.list, models.list, secrets.reload).
 * Anything else returns a generic `{ ok: true, mock: true, method }` stub
 * so the caller still gets a non-error response.
 */
export class MockGateway {
  private cronJobs: Array<Record<string, unknown>> = [
    {
      id: "mock-job-1",
      name: "sample-weekly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * 5", tz: "Europe/Paris" },
      payload: { kind: "agentTurn", message: "sample weekly digest", timeoutSeconds: 900 },
      createdAtMs: Date.now() - 7 * 24 * 3600_000,
      updatedAtMs: Date.now() - 24 * 3600_000,
    },
  ];
  private cronRuns = new Map<string, Array<Record<string, unknown>>>();
  private sessions: Array<Record<string, unknown>> = [
    {
      sessionId: "mock-session-1",
      key: "agent:main:main",
      agentId: "main",
      status: "done",
      title: "Mock main session",
      createdAtMs: Date.now() - 3600_000,
    },
  ];
  private config: Record<string, unknown> = {
    agents: { defaults: { model: { primary: "claude-sonnet-4-6" } } },
    channels: { telegram: { dmPolicy: "closed" } },
  };
  private configHash = "mock-hash-0";

  request(method: string, rawParams: unknown): unknown {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case "health":
        return { ok: true, mock: true };
      case "status":
        return {
          mock: true,
          uptimeMs: Date.now() % 1_000_000,
          agents: 1,
          sessions: this.sessions.length,
          queues: 0,
        };
      case "gateway.identity.get":
        return {
          mock: true,
          id: "mock-gateway",
          version: "mock-2026.0.0",
          owner: "mock-user",
        };
      case "agent.identity.get":
        return { mock: true, agentId: "main", displayName: "Main" };
      case "agents.list":
        return { mock: true, agents: [{ agentId: "main", displayName: "Main" }] };
      case "models.list":
        return {
          mock: true,
          models: [
            { id: "claude-sonnet-4-6", provider: "anthropic" },
            { id: "claude-opus-4-7", provider: "anthropic" },
          ],
        };
      case "cron.list":
        return { mock: true, jobs: this.cronJobs };
      case "cron.status":
        return { mock: true, enabled: true, nextRunMs: Date.now() + 3600_000 };
      case "cron.add": {
        const job = (params.job ?? {}) as Record<string, unknown>;
        const id = (job.id as string | undefined) ?? randomUUID();
        const persisted = { ...job, id, enabled: job.enabled ?? true, createdAtMs: Date.now(), updatedAtMs: Date.now() };
        this.cronJobs.push(persisted);
        return { mock: true, ok: true, job: persisted };
      }
      case "cron.update": {
        const id = (params.id as string | undefined) ?? (params.jobId as string | undefined);
        if (!id) throw new Error("mock cron.update requires id");
        const idx = this.cronJobs.findIndex((j) => j.id === id);
        if (idx === -1) throw new Error(`mock cron.update: unknown job ${id}`);
        const patch = (params.patch as Record<string, unknown> | undefined) ?? {};
        const existing = this.cronJobs[idx] ?? {};
        this.cronJobs[idx] = { ...existing, ...patch, updatedAtMs: Date.now() };
        return { mock: true, ok: true, job: this.cronJobs[idx] };
      }
      case "cron.remove": {
        const id = params.id as string;
        this.cronJobs = this.cronJobs.filter((j) => j.id !== id);
        return { mock: true, ok: true };
      }
      case "cron.run": {
        const id = params.id as string;
        const runs = this.cronRuns.get(id) ?? [];
        const entry = {
          runId: randomUUID(),
          jobId: id,
          runAtMs: Date.now(),
          status: "ok",
          summary: "[mock] dry-run completed",
        };
        runs.unshift(entry);
        this.cronRuns.set(id, runs);
        return { mock: true, ok: true, runId: entry.runId };
      }
      case "cron.runs": {
        const id = params.id as string;
        return { mock: true, entries: this.cronRuns.get(id) ?? [] };
      }
      case "sessions.list":
        return { mock: true, sessions: this.sessions };
      case "sessions.preview": {
        const keys = (params.keys as string[] | undefined) ?? [];
        const out: Record<string, unknown> = { mock: true };
        for (const k of keys) {
          out[k] = { messages: [], status: "done" };
        }
        return out;
      }
      case "sessions.create": {
        const sid = randomUUID();
        const newSession = {
          sessionId: sid,
          key: `agent:${(params.agentId as string) ?? "main"}:${sid}`,
          agentId: (params.agentId as string) ?? "main",
          status: "running",
          title: (params.title as string) ?? "(mock session)",
          createdAtMs: Date.now(),
        };
        this.sessions.push(newSession);
        return { mock: true, ok: true, session: newSession };
      }
      case "config.get":
        return {
          mock: true,
          path: "(mock)",
          exists: true,
          raw: JSON.stringify(this.config),
          parsed: this.config,
          baseHash: this.configHash,
        };
      case "config.patch": {
        const raw = params.raw as string | undefined;
        const baseHash = params.baseHash as string | undefined;
        if (!raw || !baseHash) throw new Error("mock config.patch requires {raw, baseHash}");
        if (baseHash !== this.configHash) {
          throw new Error("mock config.patch: config changed since last load; re-run config.get and retry");
        }
        this.config = JSON.parse(raw);
        this.configHash = `mock-hash-${Date.now()}`;
        return { mock: true, ok: true, baseHash: this.configHash };
      }
      case "config.schema":
        return { mock: true, schema: { type: "object" } };
      case "secrets.reload":
        return { mock: true, ok: true };
      case "logs.tail":
        return {
          mock: true,
          entries: [
            { tsMs: Date.now() - 1000, level: "info", message: "[mock] heartbeat" },
            { tsMs: Date.now() - 500, level: "info", message: "[mock] idle" },
          ],
        };
      default:
        return { mock: true, ok: true, method, note: "no canned mock handler — extend src/gateway/mock.ts to specialise" };
    }
  }
}
