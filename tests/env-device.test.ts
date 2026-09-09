import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, loadDeviceFromEnv, loadTokenFromEnv } from "../src/gateway/store.js";
import { generateDevice, toBase64Url } from "../src/gateway/device.js";

const ENV_KEYS = [
  "OPENCLAW_DEVICE_PRIVATE_KEY",
  "OPENCLAW_DEVICE_TOKEN",
  "OPENCLAW_DEVICE_ROLE",
  "OPENCLAW_DEVICE_SCOPES",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("loadDeviceFromEnv", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns undefined when OPENCLAW_DEVICE_PRIVATE_KEY is unset", async () => {
    expect(await loadDeviceFromEnv()).toBeUndefined();
  });

  it("returns undefined when OPENCLAW_DEVICE_PRIVATE_KEY is empty / whitespace", async () => {
    process.env.OPENCLAW_DEVICE_PRIVATE_KEY = "   ";
    expect(await loadDeviceFromEnv()).toBeUndefined();
  });

  it("derives publicKey + deviceId from a valid base64url private key", async () => {
    const generated = await generateDevice();
    process.env.OPENCLAW_DEVICE_PRIVATE_KEY = generated.privateKey;
    const loaded = await loadDeviceFromEnv();
    expect(loaded).toBeDefined();
    expect(loaded?.privateKey).toBe(generated.privateKey);
    expect(loaded?.publicKey).toBe(generated.publicKey);
    expect(loaded?.deviceId).toBe(generated.deviceId);
    expect(typeof loaded?.createdAtMs).toBe("number");
  });

  it("throws when the env value decodes to the wrong byte length", async () => {
    process.env.OPENCLAW_DEVICE_PRIVATE_KEY = toBase64Url(new Uint8Array(8));
    await expect(loadDeviceFromEnv()).rejects.toThrow(/32-byte/);
  });
});

describe("loadTokenFromEnv", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns undefined when OPENCLAW_DEVICE_TOKEN is unset", () => {
    expect(loadTokenFromEnv()).toBeUndefined();
  });

  it("defaults role to operator and uses operator.* scopes when only the token is set", () => {
    process.env.OPENCLAW_DEVICE_TOKEN = "tok-abc";
    const e = loadTokenFromEnv();
    expect(e).toBeDefined();
    expect(e?.token).toBe("tok-abc");
    expect(e?.role).toBe("operator");
    expect(e?.scopes).toEqual(["operator.admin", "operator.read", "operator.write"]);
  });

  it("respects custom OPENCLAW_DEVICE_ROLE and comma-separated scopes", () => {
    process.env.OPENCLAW_DEVICE_TOKEN = "tok";
    process.env.OPENCLAW_DEVICE_ROLE = "viewer";
    process.env.OPENCLAW_DEVICE_SCOPES = "operator.read, operator.admin";
    const e = loadTokenFromEnv();
    expect(e?.role).toBe("viewer");
    expect(e?.scopes).toEqual(["operator.read", "operator.admin"]);
  });
});

describe("Store env override", () => {
  let dir: string;

  beforeEach(() => {
    clearEnv();
    dir = mkdtempSync(join(tmpdir(), "openclaw-env-device-"));
  });

  afterEach(() => {
    clearEnv();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadDevice returns the env-derived device and ignores the persisted one", async () => {
    const store = new Store(dir, "store.json");
    const persisted = await generateDevice();
    await store.saveDevice({ ...persisted, createdAtMs: 1 });

    const envDevice = await generateDevice();
    process.env.OPENCLAW_DEVICE_PRIVATE_KEY = envDevice.privateKey;

    const loaded = await store.loadDevice();
    expect(loaded?.deviceId).toBe(envDevice.deviceId);
    expect(loaded?.deviceId).not.toBe(persisted.deviceId);
  });

  it("loadDevice falls back to the persisted device when env is unset", async () => {
    const store = new Store(dir, "store.json");
    const persisted = await generateDevice();
    await store.saveDevice({ ...persisted, createdAtMs: 42 });

    const loaded = await store.loadDevice();
    expect(loaded?.deviceId).toBe(persisted.deviceId);
    expect(loaded?.createdAtMs).toBe(42);
  });

  it("loadToken returns the env-derived token regardless of gatewayId", async () => {
    const store = new Store(dir, "store.json");
    await store.saveToken("gw-xyz", { token: "stored", role: "operator", scopes: ["a"], savedAtMs: 1 });
    process.env.OPENCLAW_DEVICE_TOKEN = "env-token";

    const a = await store.loadToken("gw-xyz");
    const b = await store.loadToken("any-other-gateway");
    expect(a?.token).toBe("env-token");
    expect(b?.token).toBe("env-token");
  });

  it("loadToken falls back to the persisted token when env is unset", async () => {
    const store = new Store(dir, "store.json");
    await store.saveToken("gw-xyz", { token: "stored", role: "operator", scopes: ["a"], savedAtMs: 1 });

    const e = await store.loadToken("gw-xyz");
    expect(e?.token).toBe("stored");
  });
});
