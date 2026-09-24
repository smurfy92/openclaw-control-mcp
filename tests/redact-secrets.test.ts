import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsString } from "../src/gateway/client.js";

const REDACTED = "[REDACTED]";

describe("redactSecrets", () => {
  it("redacts top-level secret-shaped keys and keeps the rest", () => {
    expect(
      redactSecrets({ method: "connect", token: "T-123", password: "hunter2", locale: "en-US" }),
    ).toEqual({ method: "connect", token: REDACTED, password: REDACTED, locale: "en-US" });
  });

  it("redacts nested keys at any depth", () => {
    const out = redactSecrets({
      params: { auth: { token: "T", deviceToken: "D" }, device: { id: "dev", privateKey: "PK" } },
    }) as { params: { auth: string; device: { id: string; privateKey: string } } };
    expect(out.params.auth).toBe(REDACTED); // whole `auth` object masked
    expect(out.params.device.id).toBe("dev");
    expect(out.params.device.privateKey).toBe(REDACTED);
  });

  it("walks into arrays, including arrays of objects", () => {
    const out = redactSecrets({
      items: [{ name: "a", secret: "S1" }, { name: "b", apiKey: "K2" }],
      scopes: ["operator.read", "operator.write"],
    }) as { items: Array<Record<string, string>>; scopes: string[] };
    expect(out.items[0]).toEqual({ name: "a", secret: REDACTED });
    expect(out.items[1]).toEqual({ name: "b", apiKey: REDACTED });
    expect(out.scopes).toEqual(["operator.read", "operator.write"]);
  });

  it("matches secret keys case-insensitively but not as substrings", () => {
    const out = redactSecrets({
      TOKEN: "A",
      Password: "B",
      BEARER: "C",
      tokenCount: 3,
      refresh_token: "D",
    }) as Record<string, unknown>;
    expect(out.TOKEN).toBe(REDACTED);
    expect(out.Password).toBe(REDACTED);
    expect(out.BEARER).toBe(REDACTED);
    // Not secret-shaped under the current anchored regex — documents the gap.
    expect(out.tokenCount).toBe(3);
    expect(out.refresh_token).toBe("D");
  });

  it("does not mutate its input", () => {
    const input = { auth: { token: "T" } };
    const out = redactSecrets(input);
    expect(input.auth.token).toBe("T");
    expect(out).not.toBe(input);
  });

  it("passes primitives and null through unchanged", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets("plain string")).toBe("plain string");
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets([])).toEqual([]);
  });
});

describe("redactSecretsString", () => {
  it("redacts a serialized frame and keeps it valid JSON", () => {
    const raw = JSON.stringify({
      type: "req",
      method: "connect",
      params: { auth: { token: "T-123" }, client: { displayName: "openclaw-control-mcp" } },
    });
    const out = redactSecretsString(raw);
    expect(out).not.toContain("T-123");
    expect(JSON.parse(out)).toMatchObject({
      method: "connect",
      params: { auth: REDACTED, client: { displayName: "openclaw-control-mcp" } },
    });
  });

  it("masks the whole payload when the string is not valid JSON", () => {
    const raw = 'token=SUPER-SECRET&password=hunter2';
    const out = redactSecretsString(raw);
    expect(out).not.toContain("SUPER-SECRET");
    expect(out).not.toContain("hunter2");
    expect(out).toContain(REDACTED);
    expect(out).toContain(String(raw.length)); // size is safe to report
  });

  it("redacts secrets nested in an array payload", () => {
    const out = redactSecretsString(JSON.stringify([{ secrets: { OPENAI: "sk-live" } }]));
    expect(out).not.toContain("sk-live");
    expect(JSON.parse(out)).toEqual([{ secrets: REDACTED }]);
  });
});
