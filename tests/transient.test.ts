import { describe, expect, it } from "vitest";
import { enrichRequestError, GatewayError, isTransientError } from "../src/gateway/client.js";

describe("isTransientError", () => {
  it.each([
    "gateway not connected",
    "gateway request 'cron.list' timed out after 30000ms",
    "ws open timeout after 30000ms",
    "gateway closed (1006): abnormal",
    "connect ECONNREFUSED 127.0.0.1:18789",
    "getaddrinfo ENOTFOUND openclaw-xxx.srv.hstgr.cloud",
    "ETIMEDOUT",
    "EAI_AGAIN openclaw-xxx",
    "socket hang up",
  ])("classifies '%s' as transient", (msg) => {
    expect(isTransientError(new Error(msg))).toBe(true);
  });

  it("does not retry user-fixable gateway errors", () => {
    const cases: Array<Partial<ConstructorParameters<typeof GatewayError>[0]>> = [
      { code: "PAIRING_REQUIRED", message: "device must be paired" },
      { code: "MISSING_SCOPE", message: "missing scope: operator.read" },
      { code: "INVALID_REQUEST", message: "invalid params" },
      { code: "FORBIDDEN", message: "forbidden" },
      { code: "NOT_FOUND", message: "no such cron" },
      { code: "UNAUTHENTICATED", message: "no token" },
      { code: "CONFLICT", message: "version mismatch" },
    ];
    for (const c of cases) {
      expect(isTransientError(new GatewayError(c))).toBe(false);
    }
  });

  it("retries gateway errors marked retryable=true", () => {
    expect(isTransientError(new GatewayError({ code: "TEMP_OVERLOADED", retryable: true }))).toBe(true);
  });

  it("does not retry random non-network errors", () => {
    expect(isTransientError(new Error("invalid arguments for tool"))).toBe(false);
    expect(isTransientError(new Error("unknown tool: foo"))).toBe(false);
  });
});

describe("enrichRequestError", () => {
  it("prefixes the message with method + attempt and preserves cause", () => {
    const original = new Error("gateway not connected");
    const wrapped = enrichRequestError(original, "cron.list", 4, 4);
    expect(wrapped.message).toBe(
      "gateway request 'cron.list' failed (attempt 4/4): gateway not connected",
    );
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(original);
  });

  it("preserves GatewayError fields (code, details, retryable)", () => {
    const orig = new GatewayError({
      code: "MISSING_SCOPE",
      message: "missing scope: operator.read",
      details: { scope: "operator.read" },
      retryable: false,
    });
    const wrapped = enrichRequestError(orig, "sessions.list", 1, 4);
    expect(wrapped).toBeInstanceOf(GatewayError);
    const gw = wrapped as GatewayError;
    expect(gw.code).toBe("MISSING_SCOPE");
    expect(gw.details).toEqual({ scope: "operator.read" });
    expect(gw.retryable).toBe(false);
    expect(gw.message.startsWith("gateway request 'sessions.list' failed (attempt 1/4): ")).toBe(true);
    expect((gw as GatewayError & { cause?: unknown }).cause).toBe(orig);
  });

  it("is idempotent on already-wrapped errors", () => {
    const orig = new Error("gateway closed");
    const once = enrichRequestError(orig, "cron.list", 4, 4);
    const twice = enrichRequestError(once, "cron.list", 4, 4);
    expect(twice).toBe(once); // returns the same object, no double-prefix
  });
});
