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

describe("MockGateway — chat workflow (sessionKey-keyed)", () => {
  it("chat.send appends a user message + auto-generates an assistant reply", () => {
    const g = new MockGateway();
    const r = g.request("chat.send", {
      sessionKey: "agent:main:main",
      message: "Hello",
      idempotencyKey: "k1",
    }) as { ok: boolean; messageId: string; replyId: string };
    expect(r.ok).toBe(true);
    expect(typeof r.messageId).toBe("string");
    expect(typeof r.replyId).toBe("string");

    const hist = g.request("chat.history", { sessionKey: "agent:main:main" }) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(hist.messages).toHaveLength(2);
    expect(hist.messages[0]?.role).toBe("user");
    expect(hist.messages[0]?.content).toBe("Hello");
    expect(hist.messages[1]?.role).toBe("assistant");
    expect(hist.messages[1]?.content).toMatch(/mock reply/);
  });

  it("chat.send rejects missing required fields (mirrors live gateway)", () => {
    const g = new MockGateway();
    expect(() => g.request("chat.send", { sessionKey: "k", message: "x" })).toThrow(/idempotencyKey/);
    expect(() => g.request("chat.send", { sessionKey: "k", idempotencyKey: "i" })).toThrow(/message/);
    expect(() => g.request("chat.send", { message: "x", idempotencyKey: "i" })).toThrow(/sessionKey/);
  });

  it("chat.history honours `limit` to slice from the tail", () => {
    const g = new MockGateway();
    for (const m of ["a", "b", "c", "d", "e"]) {
      g.request("chat.send", {
        sessionKey: "agent:main:main",
        message: m,
        idempotencyKey: `k-${m}`,
      });
    }
    const r = g.request("chat.history", { sessionKey: "agent:main:main", limit: 2 }) as {
      messages: Array<{ content: string }>;
    };
    expect(r.messages).toHaveLength(2);
  });

  it("chat.abort returns ok even on done sessions (matches live behaviour)", () => {
    const g = new MockGateway();
    const r = g.request("chat.abort", { sessionKey: "agent:main:main" }) as {
      ok: boolean;
      aborted: boolean;
    };
    expect(r.ok).toBe(true);
    expect(r.aborted).toBe(false); // session is in `done` status by default
  });
});

describe("MockGateway — sessions lifecycle", () => {
  it("sessions.create → sessions.list → sessions.send → sessions.preview", () => {
    const g = new MockGateway();
    const created = g.request("sessions.create", { agentId: "main", title: "Test" }) as {
      session: { sessionId: string; key: string; status: string };
    };
    expect(created.session.status).toBe("running");

    const list = g.request("sessions.list", {}) as { sessions: Array<{ sessionId: string }> };
    expect(list.sessions.some((s) => s.sessionId === created.session.sessionId)).toBe(true);

    g.request("sessions.send", { id: created.session.sessionId, text: "hi" });

    const preview = g.request("sessions.preview", { keys: [created.session.key] }) as Record<
      string,
      { messages: Array<{ role: string }>; status: string }
    >;
    expect(preview[created.session.key]?.messages.length).toBeGreaterThan(0);
  });

  it("sessions.abort transitions status to aborted", () => {
    const g = new MockGateway();
    const c = g.request("sessions.create", {}) as { session: { sessionId: string; key: string } };
    g.request("sessions.abort", { id: c.session.sessionId });
    const list = g.request("sessions.list", {}) as {
      sessions: Array<{ sessionId: string; status: string }>;
    };
    expect(list.sessions.find((s) => s.sessionId === c.session.sessionId)?.status).toBe("aborted");
  });

  it("sessions.reset wipes messages and brings status back to running", () => {
    const g = new MockGateway();
    const c = g.request("sessions.create", {}) as { session: { sessionId: string; key: string } };
    g.request("sessions.send", { id: c.session.sessionId, text: "hi" });
    g.request("sessions.reset", { id: c.session.sessionId });
    const preview = g.request("sessions.preview", { keys: [c.session.key] }) as Record<
      string,
      { messages: unknown[]; status: string }
    >;
    expect(preview[c.session.key]?.messages).toHaveLength(0);
    expect(preview[c.session.key]?.status).toBe("running");
  });

  it("sessions.delete removes from the list", () => {
    const g = new MockGateway();
    const c = g.request("sessions.create", {}) as { session: { sessionId: string } };
    g.request("sessions.delete", { id: c.session.sessionId });
    const list = g.request("sessions.list", {}) as { sessions: Array<{ sessionId: string }> };
    expect(list.sessions.find((s) => s.sessionId === c.session.sessionId)).toBeUndefined();
  });
});

describe("MockGateway — schema-realistic enforcement", () => {
  it("secrets.resolve requires commandName (mirrors live gateway)", () => {
    const g = new MockGateway();
    expect(() => g.request("secrets.resolve", {})).toThrow(/commandName/);
    const r = g.request("secrets.resolve", { commandName: "discord.send" }) as {
      commandName: string;
    };
    expect(r.commandName).toBe("discord.send");
  });

  it("send (root) requires `to` + idempotencyKey", () => {
    const g = new MockGateway();
    expect(() => g.request("send", {})).toThrow(/to/);
    expect(() => g.request("send", { to: "x" })).toThrow(/idempotencyKey/);
    expect(g.request("send", { to: "x", idempotencyKey: "k" })).toMatchObject({ ok: true });
  });

  it("agent (root) requires `message` + idempotencyKey", () => {
    const g = new MockGateway();
    expect(() => g.request("agent", {})).toThrow(/message/);
    expect(() => g.request("agent", { message: "x" })).toThrow(/idempotencyKey/);
    expect(g.request("agent", { message: "x", idempotencyKey: "k" })).toMatchObject({ ok: true });
  });

  it("wizard.status requires sessionId", () => {
    const g = new MockGateway();
    expect(() => g.request("wizard.status", {})).toThrow(/sessionId/);
    expect(g.request("wizard.status", { sessionId: "x" })).toMatchObject({ sessionId: "x" });
  });

  it("logs.tail returns `lines` (string[]) — matches the wrapper's expected shape", () => {
    const g = new MockGateway();
    const r = g.request("logs.tail", { limit: 50 }) as { lines: string[] };
    expect(Array.isArray(r.lines)).toBe(true);
    expect(typeof r.lines[0]).toBe("string");
    // Each line is JSON-encoded; should parse cleanly
    expect(() => JSON.parse(r.lines[0] ?? "")).not.toThrow();
  });
});

describe("MockGateway — channels + skills + tools.catalog", () => {
  it("channels.status returns the seeded channels", () => {
    const g = new MockGateway();
    const r = g.request("channels.status", {}) as {
      channels: Record<string, unknown>;
      channelOrder: string[];
    };
    expect(Object.keys(r.channels)).toContain("telegram");
    expect(Object.keys(r.channels)).toContain("discord");
  });

  it("channels.logout marks the channel as not running", () => {
    const g = new MockGateway();
    g.request("channels.logout", { channel: "discord" });
    const r = g.request("channels.status", {}) as {
      channels: Record<string, { running: boolean }>;
    };
    expect(r.channels.discord?.running).toBe(false);
  });

  it("skills.search filters by query substring", () => {
    const g = new MockGateway();
    const r = g.request("skills.search", { query: "sample" }) as {
      results: Array<{ id: string }>;
    };
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((s) => s.id.includes("sample"))).toBe(true);
  });

  it("tools.catalog returns a non-empty list", () => {
    const g = new MockGateway();
    const r = g.request("tools.catalog", {}) as { tools: Array<{ name: string }> };
    expect(r.tools.length).toBeGreaterThan(0);
  });
});

describe("MockGateway — exec.approval + agents lifecycle", () => {
  it("exec.approval.request → list → resolve flow", () => {
    const g = new MockGateway();
    const req = g.request("exec.approval.request", { command: "rm -rf /" }) as { id: string };
    const list = g.request("exec.approval.list", {}) as {
      approvals: Array<{ id: string; status: string }>;
    };
    expect(list.approvals.some((a) => a.id === req.id)).toBe(true);
    g.request("exec.approval.resolve", { id: req.id, decision: "rejected" });
    const list2 = g.request("exec.approval.list", {}) as {
      approvals: Array<{ id: string; status: string }>;
    };
    expect(list2.approvals.find((a) => a.id === req.id)?.status).toBe("rejected");
  });

  it("agents.create persists into agents.list", () => {
    const g = new MockGateway();
    const before = (g.request("agents.list", {}) as { agents: unknown[] }).agents.length;
    g.request("agents.create", { agentId: "test-bot", displayName: "Test" });
    const after = (g.request("agents.list", {}) as { agents: unknown[] }).agents.length;
    expect(after).toBe(before + 1);
  });
});
