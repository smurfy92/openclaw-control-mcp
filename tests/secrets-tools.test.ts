import { describe, expect, it } from "vitest";
import { buildSecretsTools } from "../src/tools/secrets.js";
import { makeMockClient } from "./helpers/mock-client.js";

function getTool(name: string) {
  const handle = makeMockClient();
  const tool = buildSecretsTools(handle.client).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return { tool, handle };
}

async function callTool(
  tool: { handler: (a: unknown) => Promise<unknown>; inputSchema: { safeParse: (a: unknown) => { success: boolean; error?: { message: string }; data?: unknown } } },
  args: unknown,
) {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new Error(`Zod rejected: ${parsed.error?.message}`);
  return tool.handler(parsed.data);
}

describe("openclaw_secrets_resolve — schema fix (commandName, not name)", () => {
  it("accepts commandName and forwards to gateway", async () => {
    const { tool, handle } = getTool("openclaw_secrets_resolve");
    await callTool(tool, { commandName: "discord.send" });
    expect(handle.calls[0]).toEqual({
      method: "secrets.resolve",
      params: { commandName: "discord.send" },
      opts: {},
    });
  });

  it("rejects the legacy `name` arg without `commandName`", async () => {
    const { tool } = getTool("openclaw_secrets_resolve");
    const parsed = tool.inputSchema.safeParse({ name: "OLD_NAME" });
    expect(parsed.success).toBe(false);
  });
});

describe("openclaw_secrets_set — convenience wrapper on config.patch", () => {
  function setupConfigMock(handle: ReturnType<typeof makeMockClient>) {
    handle.setRequestHandler((call) => {
      if (call.method === "config.get") {
        return {
          parsed: { secrets: { EXISTING: "keep-me" }, channels: { telegram: {} } },
          baseHash: "h-1",
        };
      }
      if (call.method === "config.patch") {
        return { ok: true, baseHash: "h-2" };
      }
      return { ok: true };
    });
  }

  it("default scope writes to config.secrets.<name>", async () => {
    const { tool, handle } = getTool("openclaw_secrets_set");
    setupConfigMock(handle);
    const r = (await callTool(tool, {
      name: "PROXYCURL_API_KEY",
      value: "pc_abc123",
    })) as { ok: boolean; path: string; baseHashAfter?: string };

    expect(r.ok).toBe(true);
    expect(r.path).toBe("secrets.PROXYCURL_API_KEY");
    expect(r.baseHashAfter).toBe("h-2");

    expect(handle.calls).toHaveLength(2);
    expect(handle.calls[0]?.method).toBe("config.get");
    expect(handle.calls[1]?.method).toBe("config.patch");

    const sent = handle.calls[1]?.params as { raw: string; baseHash: string };
    expect(sent.baseHash).toBe("h-1");
    const merged = JSON.parse(sent.raw) as Record<string, unknown>;
    expect(merged).toEqual({
      secrets: { EXISTING: "keep-me", PROXYCURL_API_KEY: "pc_abc123" },
      channels: { telegram: {} },
    });
  });

  it("custom scope writes to config.<scope>.<name>", async () => {
    const { tool, handle } = getTool("openclaw_secrets_set");
    setupConfigMock(handle);
    await callTool(tool, {
      name: "proxycurlApiKey",
      value: "pc_xyz",
      scope: "tools.linkedin-outreach",
    });
    const sent = handle.calls[1]?.params as { raw: string };
    const merged = JSON.parse(sent.raw) as Record<string, unknown>;
    expect((merged as { tools?: { "linkedin-outreach"?: { proxycurlApiKey?: string } } }).tools?.["linkedin-outreach"]?.proxycurlApiKey).toBe("pc_xyz");
    // existing branches preserved
    expect((merged as { secrets?: { EXISTING?: string } }).secrets?.EXISTING).toBe("keep-me");
  });

  it("forwards instance opt to both config.get and config.patch", async () => {
    const { tool, handle } = getTool("openclaw_secrets_set");
    setupConfigMock(handle);
    await callTool(tool, {
      name: "TEST",
      value: "v",
      instance: "work",
    });
    expect(handle.calls[0]?.opts).toEqual({ instance: "work" });
    expect(handle.calls[1]?.opts).toEqual({ instance: "work" });
  });

  it("throws if config.get returns no baseHash", async () => {
    const { tool, handle } = getTool("openclaw_secrets_set");
    handle.setRequestHandler((call) => {
      if (call.method === "config.get") return { parsed: {} };
      return { ok: true };
    });
    await expect(callTool(tool, { name: "X", value: "v" })).rejects.toThrow(/baseHash/);
  });
});
