import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE, Store } from "../src/gateway/store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-multi-instance-"));
  store = new Store(dir, "store.json", { keychain: null });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Store multi-instance API", () => {
  it("first saveConfig auto-creates the default instance", async () => {
    await store.saveConfig({ gatewayUrl: "wss://default-gw" });
    const all = await store.loadConfigs();
    expect(all.defaultInstance).toBe(DEFAULT_INSTANCE);
    expect(all.configs.default.gatewayUrl).toBe("wss://default-gw");
  });

  it("multiple instances coexist without collision", async () => {
    await store.saveConfig({ gatewayUrl: "wss://perso-gw", gatewayToken: "T-PERSO" }, "perso");
    await store.saveConfig({ gatewayUrl: "wss://work-gw", gatewayToken: "T-WORK" }, "work");
    const all = await store.loadConfigs();
    expect(Object.keys(all.configs).sort()).toEqual(["perso", "work"]);
    expect(all.configs.perso.gatewayUrl).toBe("wss://perso-gw");
    expect(all.configs.work.gatewayUrl).toBe("wss://work-gw");
    expect(all.configs.perso.gatewayToken).toBe("T-PERSO"); // no keychain → token stays in JSON
    expect(all.configs.work.gatewayToken).toBe("T-WORK");
  });

  it("loadConfig falls back to default when instance is omitted", async () => {
    await store.saveConfig({ gatewayUrl: "wss://default-gw" });
    await store.saveConfig({ gatewayUrl: "wss://perso-gw" }, "perso");
    const cfg = await store.loadConfig();
    expect(cfg.gatewayUrl).toBe("wss://default-gw");
  });

  it("loadConfig fetches a specific named instance", async () => {
    await store.saveConfig({ gatewayUrl: "wss://default-gw" });
    await store.saveConfig({ gatewayUrl: "wss://perso-gw" }, "perso");
    const cfg = await store.loadConfig("perso");
    expect(cfg.gatewayUrl).toBe("wss://perso-gw");
  });

  it("loadConfig returns {} for unknown instance", async () => {
    const cfg = await store.loadConfig("nope");
    expect(cfg).toEqual({});
  });

  it("setDefaultInstance switches the active default", async () => {
    await store.saveConfig({ gatewayUrl: "wss://a" }, "a");
    await store.saveConfig({ gatewayUrl: "wss://b" }, "b");
    let all = await store.loadConfigs();
    expect(all.defaultInstance).toBe("a"); // first saved becomes default

    await store.setDefaultInstance("b");
    all = await store.loadConfigs();
    expect(all.defaultInstance).toBe("b");
  });

  it("setDefaultInstance throws on unknown instance", async () => {
    await expect(store.setDefaultInstance("ghost")).rejects.toThrow(/unknown instance/);
  });

  it("clearConfig with a name removes only that instance", async () => {
    await store.saveConfig({ gatewayUrl: "wss://a" }, "a");
    await store.saveConfig({ gatewayUrl: "wss://b" }, "b");
    await store.clearConfig("a");
    const all = await store.loadConfigs();
    expect(Object.keys(all.configs)).toEqual(["b"]);
    expect(all.defaultInstance).toBe("b"); // default migrated when "a" disappeared
  });

  it("clearConfig with no arg wipes everything", async () => {
    await store.saveConfig({ gatewayUrl: "wss://a" }, "a");
    await store.saveConfig({ gatewayUrl: "wss://b" }, "b");
    await store.clearConfig();
    const all = await store.loadConfigs();
    expect(Object.keys(all.configs)).toEqual([]);
    expect(all.defaultInstance).toBe(DEFAULT_INSTANCE); // empty store falls back to "default" label
  });
});

describe("Store v1 → v2 migration", () => {
  it("auto-migrates a legacy v1 store.json on first load", async () => {
    // Hand-craft a v1 store as if persisted by an older version of this MCP.
    const legacyV1 = {
      version: 1,
      device: {
        deviceId: "abc",
        publicKey: "PK",
        privateKey: "SK",
        createdAtMs: 1_700_000_000_000,
      },
      tokens: {
        "gw-aaa": { token: "T", role: "operator", scopes: [], savedAtMs: 1 },
      },
      config: {
        gatewayUrl: "wss://legacy-gw",
        gatewayToken: "LEGACY-TOKEN",
        savedAtMs: 1_700_000_000_000,
      },
    };
    writeFileSync(join(dir, "store.json"), JSON.stringify(legacyV1, null, 2));

    const cfg = await store.loadConfig();
    expect(cfg.gatewayUrl).toBe("wss://legacy-gw");
    expect(cfg.gatewayToken).toBe("LEGACY-TOKEN");

    // Persisting writes a v2 shape with `configs.default`, no more `config`.
    await store.saveConfig({ gatewayUrl: "wss://legacy-gw" });
    const json = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      version: number;
      configs?: Record<string, { gatewayUrl: string }>;
      config?: unknown;
      defaultInstance?: string;
    };
    expect(json.version).toBe(2);
    expect(json.config).toBeUndefined();
    expect(json.configs?.default.gatewayUrl).toBe("wss://legacy-gw");
    expect(json.defaultInstance).toBe(DEFAULT_INSTANCE);
  });
});
