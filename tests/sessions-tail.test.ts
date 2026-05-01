import { describe, expect, it } from "vitest";
import { buildSessionsTools } from "../src/tools/sessions.js";
import type { GatewayClient } from "../src/gateway/client.js";

type Preview = { messages: Array<{ id: string; content: string }>; status?: string };

function makeClient(scripted: Preview[]): { client: GatewayClient; calls: { method: string; args: unknown }[] } {
  const calls: { method: string; args: unknown }[] = [];
  let i = 0;
  const client = {
    request: async (method: string, args: unknown) => {
      calls.push({ method, args });
      const key = (args as { keys: string[] }).keys[0];
      const preview = scripted[Math.min(i, scripted.length - 1)] ?? { messages: [] };
      i++;
      return { [key]: preview };
    },
  } as unknown as GatewayClient;
  return { client, calls };
}

describe("openclaw_sessions_tail", () => {
  it("schema: rejects key < 1 char", () => {
    const tail = buildSessionsTools({} as GatewayClient).find((t) => t.name === "openclaw_sessions_tail")!;
    expect(tail.inputSchema.safeParse({ key: "" }).success).toBe(false);
  });

  it("schema: enforces durationMs/intervalMs bounds", () => {
    const tail = buildSessionsTools({} as GatewayClient).find((t) => t.name === "openclaw_sessions_tail")!;
    expect(tail.inputSchema.safeParse({ key: "k", durationMs: 500 }).success).toBe(false); // < 1000
    expect(tail.inputSchema.safeParse({ key: "k", durationMs: 400_000 }).success).toBe(false); // > 300_000
    expect(tail.inputSchema.safeParse({ key: "k", intervalMs: 100 }).success).toBe(false); // < 500
    expect(tail.inputSchema.safeParse({ key: "k", intervalMs: 20_000 }).success).toBe(false); // > 10_000
  });

  it("schema: applies defaults for durationMs/intervalMs", () => {
    const tail = buildSessionsTools({} as GatewayClient).find((t) => t.name === "openclaw_sessions_tail")!;
    const parsed = tail.inputSchema.parse({ key: "agent:main:cron:abc" });
    expect(parsed.durationMs).toBe(30_000);
    expect(parsed.intervalMs).toBe(2_000);
  });

  it("seeds existing messages on first poll, returns only new ones afterwards", async () => {
    const { client } = makeClient([
      { messages: [{ id: "m1", content: "old" }], status: "running" },
      { messages: [{ id: "m1", content: "old" }, { id: "m2", content: "new!" }], status: "running" },
    ]);
    const tail = buildSessionsTools(client).find((t) => t.name === "openclaw_sessions_tail")!;

    const result = (await tail.handler({
      key: "agent:main:cron:abc",
      durationMs: 1500,
      intervalMs: 500,
    })) as { newMessages: { id: string }[]; polls: number; stoppedReason: string };

    expect(result.newMessages.map((m) => m.id)).toEqual(["m2"]);
    expect(result.polls).toBeGreaterThanOrEqual(2);
    expect(result.stoppedReason).toBe("duration");
  });

  it("stops early once the session reaches a terminal status (initial preview)", async () => {
    const { client, calls } = makeClient([
      { messages: [{ id: "m1", content: "final" }], status: "done" },
    ]);
    const tail = buildSessionsTools(client).find((t) => t.name === "openclaw_sessions_tail")!;

    const result = (await tail.handler({
      key: "agent:main:cron:abc",
      durationMs: 30_000,
      intervalMs: 2_000,
    })) as { stoppedReason: string; lastStatus: string; polls: number };

    expect(result.stoppedReason).toBe("sessionDone");
    expect(result.lastStatus).toBe("done");
    expect(result.polls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("stops early once maxMessages new messages have been collected", async () => {
    const { client } = makeClient([
      { messages: [], status: "running" }, // seed
      { messages: [{ id: "m1", content: "a" }], status: "running" },
      { messages: [{ id: "m1", content: "a" }, { id: "m2", content: "b" }], status: "running" },
    ]);
    const tail = buildSessionsTools(client).find((t) => t.name === "openclaw_sessions_tail")!;

    const result = (await tail.handler({
      key: "agent:main:cron:abc",
      durationMs: 5_000,
      intervalMs: 500,
      maxMessages: 2,
    })) as { stoppedReason: string; newMessages: unknown[] };

    expect(result.stoppedReason).toBe("maxMessages");
    expect(result.newMessages).toHaveLength(2);
  });

  it("stops early when a later poll surfaces a terminal status", async () => {
    const { client } = makeClient([
      { messages: [], status: "running" },
      { messages: [{ id: "m1", content: "reply" }], status: "done" },
    ]);
    const tail = buildSessionsTools(client).find((t) => t.name === "openclaw_sessions_tail")!;

    const result = (await tail.handler({
      key: "agent:main:cron:abc",
      durationMs: 5_000,
      intervalMs: 500,
    })) as { stoppedReason: string; newMessages: { id: string }[]; lastStatus: string };

    expect(result.stoppedReason).toBe("sessionDone");
    expect(result.lastStatus).toBe("done");
    expect(result.newMessages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("dedupes messages without ids using role + timestamp + content prefix", async () => {
    const { client } = makeClient([
      { messages: [{ role: "user", createdAtMs: 1, content: "hi" } as never], status: "running" },
      {
        messages: [
          { role: "user", createdAtMs: 1, content: "hi" } as never,
          { role: "assistant", createdAtMs: 2, content: "hello" } as never,
        ],
        status: "running",
      },
    ]);
    const tail = buildSessionsTools(client).find((t) => t.name === "openclaw_sessions_tail")!;

    const result = (await tail.handler({
      key: "agent:main:cron:abc",
      durationMs: 1_500,
      intervalMs: 500,
    })) as { newMessages: Array<{ role: string; content: string }> };

    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0].role).toBe("assistant");
    expect(result.newMessages[0].content).toBe("hello");
  });
});
