import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/gateway/store.js";
import type { KeychainBackend } from "../src/gateway/keychain.js";
import { resolveKeychainBackend, maybeKeychainBackend } from "../src/gateway/keychain.js";

class InMemoryKeychain implements KeychainBackend {
  readonly id = "in-memory-test";
  readonly entries = new Map<string, string>();
  async isAvailable() {
    return true;
  }
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.entries.set(key, value);
  }
  async delete(key: string) {
    this.entries.delete(key);
  }
}

describe("maybeKeychainBackend env-gating", () => {
  const original = process.env.OPENCLAW_USE_KEYCHAIN;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCLAW_USE_KEYCHAIN;
    else process.env.OPENCLAW_USE_KEYCHAIN = original;
  });

  it("returns null when OPENCLAW_USE_KEYCHAIN is unset", async () => {
    delete process.env.OPENCLAW_USE_KEYCHAIN;
    expect(await maybeKeychainBackend()).toBeNull();
  });

  it("returns null when OPENCLAW_USE_KEYCHAIN is not '1'", async () => {
    process.env.OPENCLAW_USE_KEYCHAIN = "yes";
    expect(await maybeKeychainBackend()).toBeNull();
  });
});

describe("resolveKeychainBackend always returns something", () => {
  it("returns a backend (real or noop) without throwing", async () => {
    const b = await resolveKeychainBackend();
    expect(b).toBeTruthy();
    expect(typeof b.id).toBe("string");
  });

  it("noop fallback never throws on get/delete", async () => {
    const b = await resolveKeychainBackend();
    if (b.id !== "noop") return; // skip when a real backend is present (CI on a Mac)
    expect(await b.get("anything")).toBeNull();
    await expect(b.delete("anything")).resolves.toBeUndefined();
  });
});

describe("Store + InMemoryKeychain — secret splitting", () => {
  let dir: string;
  let kc: InMemoryKeychain;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openclaw-store-test-"));
    kc = new InMemoryKeychain();
    store = new Store(dir, "store.json", { keychain: kc });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips secrets from store.json on save and pushes them to keychain", async () => {
    await store.saveDevice({
      deviceId: "deadbeef",
      publicKey: "PUBKEY",
      privateKey: "SECRET-PRIVATE-KEY",
      createdAtMs: 1_700_000_000_000,
    });

    const json = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      device?: { privateKey: string; publicKey: string };
    };
    expect(json.device?.publicKey).toBe("PUBKEY"); // public stays in JSON
    expect(json.device?.privateKey).toBe(""); // secret blanked in JSON
    expect(kc.entries.get("device-private-key")).toBe("SECRET-PRIVATE-KEY");
  });

  it("hydrates secrets from keychain on load", async () => {
    await store.saveDevice({
      deviceId: "deadbeef",
      publicKey: "PUBKEY",
      privateKey: "SECRET-PRIVATE-KEY",
      createdAtMs: 1_700_000_000_000,
    });

    // Fresh store instance pointing at the same dir + same keychain
    const fresh = new Store(dir, "store.json", { keychain: kc });
    const device = await fresh.loadDevice();
    expect(device?.privateKey).toBe("SECRET-PRIVATE-KEY"); // re-hydrated
    expect(device?.publicKey).toBe("PUBKEY");
  });

  it("splits per-gateway tokens correctly", async () => {
    await store.saveToken("gw-aaa", { token: "TOKEN-AAA", role: "operator", scopes: [], savedAtMs: 1 });
    await store.saveToken("gw-bbb", { token: "TOKEN-BBB", role: "operator", scopes: [], savedAtMs: 2 });

    expect(kc.entries.get("device-token:gw-aaa")).toBe("TOKEN-AAA");
    expect(kc.entries.get("device-token:gw-bbb")).toBe("TOKEN-BBB");

    const json = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      tokens: Record<string, { token: string }>;
    };
    expect(json.tokens["gw-aaa"].token).toBe("");
    expect(json.tokens["gw-bbb"].token).toBe("");
  });

  it("clearToken removes both the JSON entry and the keychain secret", async () => {
    await store.saveToken("gw-zzz", { token: "TOKEN-ZZZ", role: "operator", scopes: [], savedAtMs: 1 });
    expect(kc.entries.has("device-token:gw-zzz")).toBe(true);

    await store.clearToken("gw-zzz");
    expect(kc.entries.has("device-token:gw-zzz")).toBe(false);
  });

  it("config secrets (gatewayToken, gatewayPassword) get split too", async () => {
    await store.saveConfig({
      gatewayUrl: "wss://x",
      gatewayToken: "TOKEN-CFG",
      gatewayPassword: "PWD-CFG",
    });
    expect(kc.entries.get("gateway-token")).toBe("TOKEN-CFG");
    expect(kc.entries.get("gateway-password")).toBe("PWD-CFG");
    const json = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      config: { gatewayUrl: string; gatewayToken: string; gatewayPassword: string };
    };
    expect(json.config.gatewayUrl).toBe("wss://x"); // non-secret stays
    expect(json.config.gatewayToken).toBe("");
    expect(json.config.gatewayPassword).toBe("");
  });

  it("clearConfig wipes both the JSON config and the keychain secrets", async () => {
    await store.saveConfig({ gatewayUrl: "wss://x", gatewayToken: "T", gatewayPassword: "P" });
    expect(kc.entries.has("gateway-token")).toBe(true);
    await store.clearConfig();
    expect(kc.entries.has("gateway-token")).toBe(false);
    expect(kc.entries.has("gateway-password")).toBe(false);
  });

  it("secretsLocation reflects the active backend", async () => {
    expect(await store.secretsLocation()).toBe("in-memory-test + store.json");
  });
});

describe("Store without keychain (legacy 0.3.x behaviour)", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openclaw-store-test-no-kc-"));
    store = new Store(dir, "store.json", { keychain: null });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps secrets in store.json when no keychain is configured", async () => {
    await store.saveDevice({
      deviceId: "abc",
      publicKey: "PK",
      privateKey: "SK",
      createdAtMs: 1,
    });

    const json = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      device: { privateKey: string };
    };
    expect(json.device.privateKey).toBe("SK"); // legacy: secret stays in JSON
  });

  it("secretsLocation reports plain JSON", async () => {
    expect(await store.secretsLocation()).toBe("store.json");
  });

  it("creates the file at the expected path", async () => {
    await store.saveConfig({ gatewayUrl: "wss://x" });
    expect(existsSync(join(dir, "store.json"))).toBe(true);
  });
});
