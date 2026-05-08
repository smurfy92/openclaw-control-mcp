import { describe, expect, it } from "vitest";
import { MockGateway } from "../src/gateway/mock.js";

describe("MockGateway — in-memory dry-run", () => {
  it("returns canned health/status/identity responses", () => {
    const g = new MockGateway();
    expect(g.request("health", {})).toMatchObject({ ok: true, mock: true });
    expect(g.request("status", {})).toMatchObject({ mock: true });
    expect(g.request("gateway.identity.get", {})).toMatchObject({
      mock: true,
      version: "mock-2026.0.0",
    });
  });

  it("seeds at least one cron job and returns it via cron.list", () => {
    const g = new MockGateway();
    const r = g.request("cron.list", {}) as { jobs: Array<{ name: string }> };
    expect(r.jobs.length).toBeGreaterThanOrEqual(1);
    expect(r.jobs[0]?.name).toBe("sample-weekly");
  });

  it("cron.add persists the new job and returns it on subsequent cron.list", () => {
    const g = new MockGateway();
    const before = (g.request("cron.list", {}) as { jobs: unknown[] }).jobs.length;
    const added = g.request("cron.add", {
      job: {
        name: "test-job",
        schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "x", timeoutSeconds: 60 },
      },
    }) as { ok: boolean; job: { id: string; name: string } };
    expect(added.ok).toBe(true);
    expect(added.job.id).toBeTruthy();
    const after = g.request("cron.list", {}) as { jobs: Array<{ name: string }> };
    expect(after.jobs.length).toBe(before + 1);
    expect(after.jobs.find((j) => j.name === "test-job")).toBeTruthy();
  });

  it("cron.update merges patch into the named job", () => {
    const g = new MockGateway();
    g.request("cron.update", { id: "mock-job-1", patch: { enabled: false } });
    const r = g.request("cron.list", {}) as { jobs: Array<{ id: string; enabled: boolean }> };
    const seeded = r.jobs.find((j) => j.id === "mock-job-1");
    expect(seeded?.enabled).toBe(false);
  });

  it("cron.update throws on unknown id", () => {
    const g = new MockGateway();
    expect(() => g.request("cron.update", { id: "nope", patch: {} })).toThrow(/unknown job/);
  });

  it("cron.run records a run, cron.runs returns it", () => {
    const g = new MockGateway();
    g.request("cron.run", { id: "mock-job-1" });
    g.request("cron.run", { id: "mock-job-1" });
    const r = g.request("cron.runs", { id: "mock-job-1" }) as { entries: Array<{ jobId: string }> };
    expect(r.entries.length).toBe(2);
    expect(r.entries[0]?.jobId).toBe("mock-job-1");
  });

  it("config.patch enforces optimistic-locking baseHash", () => {
    const g = new MockGateway();
    const get1 = g.request("config.get", {}) as { baseHash: string; parsed: Record<string, unknown> };
    const ok = g.request("config.patch", {
      raw: JSON.stringify({ ...get1.parsed, foo: "bar" }),
      baseHash: get1.baseHash,
    }) as { ok: boolean };
    expect(ok.ok).toBe(true);

    // Reusing the now-stale hash must fail
    expect(() =>
      g.request("config.patch", {
        raw: JSON.stringify({ second: true }),
        baseHash: get1.baseHash,
      }),
    ).toThrow(/config changed since last load/);
  });

  it("falls back to a generic stub for un-canned methods", () => {
    const g = new MockGateway();
    const r = g.request("some.uncovered.method", { foo: 1 }) as {
      mock: boolean;
      ok: boolean;
      method: string;
      note: string;
    };
    expect(r.mock).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("some.uncovered.method");
    expect(r.note).toMatch(/extend src\/gateway\/mock.ts/);
  });
});
