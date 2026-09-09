import { describe, expect, it } from "vitest";
import { mergeCreds } from "../src/gateway/store.js";

describe("mergeCreds — env wins per field", () => {
  it("env token wins over store value", () => {
    const r = mergeCreds(
      { token: "ENV-T", password: undefined },
      { gatewayToken: "STORE-T" },
    );
    expect(r.token).toBe("ENV-T");
  });

  it("env token wins over EMPTY store value (post-wipe scenario)", () => {
    // The bug from 2026-05-10: store had `gatewayToken: ""` after a manual
    // wipe; the pre-0.6.2 code used `cfg.gatewayToken` directly, so
    // ENV_TOKEN was silently ignored and the gateway received auth: {}.
    const r = mergeCreds(
      { token: "ENV-T", password: undefined },
      { gatewayToken: "" },
    );
    expect(r.token).toBe("ENV-T");
  });

  it("falls back to store when env is unset", () => {
    const r = mergeCreds(
      { token: undefined, password: undefined },
      { gatewayToken: "STORE-T", gatewayPassword: "STORE-P" },
    );
    expect(r.token).toBe("STORE-T");
    expect(r.password).toBe("STORE-P");
  });

  it("returns undefined when both env and store are empty", () => {
    const r = mergeCreds({}, { gatewayToken: "", gatewayPassword: "" });
    expect(r.token).toBeUndefined();
    expect(r.password).toBeUndefined();
  });

  it("password follows the same env-wins-per-field rule", () => {
    const r = mergeCreds(
      { token: undefined, password: "ENV-P" },
      { gatewayToken: "STORE-T", gatewayPassword: "STORE-P" },
    );
    expect(r.token).toBe("STORE-T"); // store wins (env unset)
    expect(r.password).toBe("ENV-P"); // env wins
  });
});
