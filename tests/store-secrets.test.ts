import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/gateway/store.js";

/**
 * Replaces the old keychain.test.ts. Since 0.8.0 there is no OS keychain:
 * secrets live in `store.json` (mode 0600) or come from the environment
 * (typically a `.env` file). These tests pin that contract.
 */

let dir: string;
let store: Store;
const SECRET_ENV = [
  "OPENCLAW_DEVICE_PRIVATE_KEY",
  "OPENCLAW_DEVICE_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-store-secrets-"));
  store = new Store(dir, "store.json");
  saved = Object.fromEntries(SECRET_ENV.map((k) => [k, process.env[k]]));
  for (const k of SECRET_ENV) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const readRaw = () => JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));

describe("Store — secrets on disk", () => {
  it("persists the device private key in store.json and reads it back", async () => {
    await store.saveDevice({
      deviceId: "dev-1",
      publicKey: "PUB",
      privateKey: "PRIV-KEY",
      createdAtMs: 1,
    });
    expect(readRaw().device.privateKey).toBe("PRIV-KEY");

    const fresh = new Store(dir, "store.json");
    expect((await fresh.loadDevice())?.privateKey).toBe("PRIV-KEY");
  });

  it("persists device tokens and gateway credentials", async () => {
    await store.saveToken("gw-1", { token: "TOK", role: "operator", scopes: ["operator.read"], savedAtMs: 1 });
    await store.saveConfig({ gatewayUrl: "wss://gw", gatewayToken: "GT", gatewayPassword: "GP" });

    const raw = readRaw();
    expect(raw.tokens["gw-1"].token).toBe("TOK");
    expect(raw.configs.default.gatewayToken).toBe("GT");
    expect(raw.configs.default.gatewayPassword).toBe("GP");

    const fresh = new Store(dir, "store.json");
    expect((await fresh.loadToken("gw-1"))?.token).toBe("TOK");
    expect((await fresh.loadConfig()).gatewayPassword).toBe("GP");
  });

  it("writes store.json with mode 0600", async () => {
    await store.saveConfig({ gatewayUrl: "wss://gw" });
    expect(statSync(join(dir, "store.json")).mode & 0o777).toBe(0o600);
  });

  it("clearToken removes the entry", async () => {
    await store.saveToken("gw-1", { token: "TOK", role: "operator", scopes: [], savedAtMs: 1 });
    await store.clearToken("gw-1");
    expect(await store.loadToken("gw-1")).toBeUndefined();
    expect(readRaw().tokens["gw-1"]).toBeUndefined();
  });

  it("clearConfig(instance) drops just that instance's credentials", async () => {
    await store.saveConfig({ gatewayUrl: "wss://a", gatewayToken: "A" }, "a");
    await store.saveConfig({ gatewayUrl: "wss://b", gatewayToken: "B" }, "b");
    await store.clearConfig("a");

    const all = await store.loadConfigs();
    expect(Object.keys(all.configs)).toEqual(["b"]);
    expect(JSON.stringify(readRaw())).not.toContain("\"A\"");
  });
});

describe("Store — env overrides win over the file", () => {
  it("loadDevice prefers OPENCLAW_DEVICE_PRIVATE_KEY", async () => {
    await store.saveDevice({ deviceId: "d", publicKey: "P", privateKey: "FROM-FILE", createdAtMs: 1 });
    // 32 zero bytes, base64url — the shape loadDeviceFromEnv requires.
    process.env.OPENCLAW_DEVICE_PRIVATE_KEY = Buffer.alloc(32).toString("base64url");

    const device = await store.loadDevice();
    expect(device?.privateKey).not.toBe("FROM-FILE");
  });

  it("loadToken prefers OPENCLAW_DEVICE_TOKEN", async () => {
    await store.saveToken("gw-1", { token: "FROM-FILE", role: "operator", scopes: [], savedAtMs: 1 });
    process.env.OPENCLAW_DEVICE_TOKEN = "FROM-ENV";
    expect((await store.loadToken("gw-1"))?.token).toBe("FROM-ENV");
  });

  it("secretsLocation names the file, and the env vars when present", async () => {
    expect(store.secretsLocation()).toBe(`${join(dir, "store.json")} (mode 0600)`);
    process.env.OPENCLAW_GATEWAY_TOKEN = "x";
    expect(store.secretsLocation()).toContain("env: OPENCLAW_GATEWAY_TOKEN");
  });
});

describe("Store — device integrity + repair", () => {
  it("reports no-device, missing-private-key and ok", async () => {
    expect(await store.deviceIntegrity()).toBe("no-device");

    writeFileSync(
      join(dir, "store.json"),
      JSON.stringify({ version: 2, device: { deviceId: "d", publicKey: "P", privateKey: "", createdAtMs: 1 } }),
    );
    expect(await store.deviceIntegrity()).toBe("missing-private-key");

    await store.saveDevice({ deviceId: "d", publicKey: "P", privateKey: "K", createdAtMs: 1 });
    expect(await store.deviceIntegrity()).toBe("ok");
  });

  it("repairDevice wipes device + tokens, keeps configs, and backs up the file", async () => {
    await store.saveDevice({ deviceId: "d", publicKey: "P", privateKey: "K", createdAtMs: 1 });
    await store.saveToken("gw-1", { token: "TOK", role: "operator", scopes: [], savedAtMs: 1 });
    await store.saveConfig({ gatewayUrl: "wss://gw", gatewayToken: "GT" });

    const report = await store.repairDevice();
    expect(report.wiped).toEqual({ device: true, tokenCount: 1 });
    expect(report.backupPath).toBeTruthy();
    expect(readdirSync(dir).some((f) => f.startsWith("store.json.bak."))).toBe(true);

    expect(await store.deviceIntegrity()).toBe("no-device");
    expect(await store.loadToken("gw-1")).toBeUndefined();
    // Configs survive so the user doesn't have to re-enter the gateway URL.
    expect((await store.loadConfig()).gatewayToken).toBe("GT");
  });
});

describe("Store.importSecrets — the --migrate-from-keychain seam", () => {
  it("fills only the empty fields and reports what it wrote", async () => {
    writeFileSync(
      join(dir, "store.json"),
      JSON.stringify({
        version: 2,
        device: { deviceId: "d", publicKey: "P", privateKey: "", createdAtMs: 1 },
        tokens: { "gw-1": { token: "", role: "operator", scopes: [], savedAtMs: 1 } },
        configs: { default: { gatewayUrl: "wss://gw", gatewayToken: "ALREADY-SET" } },
        defaultInstance: "default",
      }),
    );

    const applied = await store.importSecrets({
      device: { privateKey: "RECOVERED" },
      tokens: { "gw-1": "RECOVERED-TOKEN" },
      configs: { default: { gatewayToken: "IGNORED", gatewayPassword: "RECOVERED-PW" } },
    });

    expect(applied).toEqual(["device.privateKey", "tokens.gw-1", "configs.default.gatewayPassword"]);
    const raw = readRaw();
    expect(raw.device.privateKey).toBe("RECOVERED");
    expect(raw.tokens["gw-1"].token).toBe("RECOVERED-TOKEN");
    expect(raw.configs.default.gatewayToken).toBe("ALREADY-SET"); // not clobbered
    expect(raw.configs.default.gatewayPassword).toBe("RECOVERED-PW");
  });

  it("is idempotent — a second run writes nothing", async () => {
    await store.saveDevice({ deviceId: "d", publicKey: "P", privateKey: "K", createdAtMs: 1 });
    expect(await store.importSecrets({ device: { privateKey: "OTHER" } })).toEqual([]);
    expect(readRaw().device.privateKey).toBe("K");
  });
});
