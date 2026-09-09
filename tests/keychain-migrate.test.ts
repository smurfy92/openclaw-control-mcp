import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/gateway/store.js";
import { migrateFromKeychain } from "../src/gateway/keychain-migrate.js";

/**
 * The `--migrate-from-keychain` importer. The reader is injected here so these
 * cases never touch a real OS keychain — which is exactly the property the
 * whole 0.8.0 change is about.
 */

let dir: string;
let store: Store;

/** Fake keychain: a map, read-only from the migrator's point of view. */
const makeReader = (items: Record<string, string>) => ({
  id: "macos-security",
  get: (key: string) => items[key] ?? null,
});

const BLANKED_STORE = {
  version: 2,
  device: { deviceId: "d", publicKey: "P", privateKey: "", createdAtMs: 1 },
  tokens: { "gw-1": { token: "", role: "operator", scopes: ["operator.read"], savedAtMs: 1 } },
  configs: { default: { gatewayUrl: "wss://gw", gatewayToken: "", gatewayPassword: "" } },
  defaultInstance: "default",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-kc-migrate-"));
  store = new Store(dir, "store.json");
  writeFileSync(join(dir, "store.json"), JSON.stringify(BLANKED_STORE));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readRaw = () => JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));

describe("migrateFromKeychain", () => {
  it("imports the 0.6.1+ single-item bundle into store.json", async () => {
    const reader = makeReader({
      "secrets-bundle": JSON.stringify({
        version: 1,
        device: { privateKey: "PRIV" },
        tokens: { "gw-1": "DEVTOK" },
        configs: { default: { gatewayToken: "GT", gatewayPassword: "GP" } },
      }),
    });

    const report = await migrateFromKeychain(store, reader);
    expect(report.ok).toBe(true);
    expect(report.imported).toEqual([
      "device.privateKey",
      "tokens.gw-1",
      "configs.default.gatewayToken",
      "configs.default.gatewayPassword",
    ]);

    const raw = readRaw();
    expect(raw.device.privateKey).toBe("PRIV");
    expect(raw.tokens["gw-1"].token).toBe("DEVTOK");
    expect(raw.configs.default.gatewayToken).toBe("GT");
  });

  it("falls back to the pre-0.6.1 per-secret items", async () => {
    const reader = makeReader({
      "device-private-key": "PRIV",
      "device-token:gw-1": "DEVTOK",
      "gateway-token": "LEGACY-GT", // un-namespaced, default instance only
    });

    const report = await migrateFromKeychain(store, reader);
    expect(report.ok).toBe(true);
    const raw = readRaw();
    expect(raw.device.privateKey).toBe("PRIV");
    expect(raw.tokens["gw-1"].token).toBe("DEVTOK");
    expect(raw.configs.default.gatewayToken).toBe("LEGACY-GT");
  });

  it("suggests delete commands but never deletes anything itself", async () => {
    const reader = makeReader({ "device-private-key": "PRIV" });
    const report = await migrateFromKeychain(store, reader);

    expect(report.leftoverItems).toEqual([
      "security delete-generic-password -a " +
        (await import("node:os")).userInfo().username +
        " -s openclaw-control-mcp:device-private-key",
    ]);
    // The fake reader has no mutation surface at all — the migrator only reads.
    expect(Object.keys(reader)).toEqual(["id", "get"]);
  });

  it("is idempotent — a second run imports nothing", async () => {
    const reader = makeReader({
      "secrets-bundle": JSON.stringify({ version: 1, device: { privateKey: "PRIV" } }),
    });
    await migrateFromKeychain(store, reader);
    const second = await migrateFromKeychain(store, reader);
    expect(second.imported).toEqual([]);
    expect(readRaw().device.privateKey).toBe("PRIV");
  });

  it("reports cleanly when there is no keychain on this host", async () => {
    const report = await migrateFromKeychain(store, null);
    expect(report.ok).toBe(false);
    expect(report.message).toContain("No OS keychain CLI found");
    expect(readRaw().device.privateKey).toBe("");
  });

  it("reports cleanly when the keychain holds nothing of ours", async () => {
    const report = await migrateFromKeychain(store, makeReader({}));
    expect(report.ok).toBe(false);
    expect(report.imported).toEqual([]);
    expect(report.message).toContain("No openclaw-control-mcp secrets found");
  });

  it("ignores a corrupt bundle and falls through to the legacy items", async () => {
    const reader = makeReader({ "secrets-bundle": "{not json", "device-private-key": "PRIV" });
    const report = await migrateFromKeychain(store, reader);
    expect(report.ok).toBe(true);
    expect(readRaw().device.privateKey).toBe("PRIV");
  });
});
