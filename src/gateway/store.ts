import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { DeviceIdentity } from "./device.js";
import { type KeychainBackend, maybeKeychainBackend } from "./keychain.js";

export type DeviceTokenEntry = {
  token: string;
  role: string;
  scopes: string[];
  savedAtMs: number;
};

export type GatewayConfigShape = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  timeoutMs?: number;
  savedAtMs?: number;
};

export type StoreShape = {
  version: 1;
  device?: DeviceIdentity & { createdAtMs: number };
  tokens?: Record<string, DeviceTokenEntry>;
  config?: GatewayConfigShape;
};

const XDG_BASE = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const LEGACY_DIR = join(XDG_BASE, "openclaw-claw-mcp");
const DEFAULT_DIR =
  process.env.OPENCLAW_CONTROL_HOME ??
  process.env.OPENCLAW_CLAW_HOME ?? // backward-compat for early adopters
  join(XDG_BASE, "openclaw-control-mcp");

export class Store {
  private path: string;
  // undefined = not yet probed, null = checked and unavailable, KeychainBackend = active.
  private keychain: KeychainBackend | null | undefined = undefined;

  constructor(
    dir: string = DEFAULT_DIR,
    fileName: string = "store.json",
    options: { keychain?: KeychainBackend | null } = {},
  ) {
    this.path = join(dir, fileName);
    // Allow callers (tests) to inject or disable the keychain. `undefined`
    // keeps the default lazy probe behaviour.
    if (options.keychain !== undefined) this.keychain = options.keychain;
  }

  static gatewayId(url: string): string {
    return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
  }

  private async getKeychain(): Promise<KeychainBackend | null> {
    if (this.keychain !== undefined) return this.keychain;
    this.keychain = await maybeKeychainBackend();
    return this.keychain;
  }

  /**
   * Returns a label describing where secrets are persisted, useful for
   * `openclaw_setup_show` / `--health` output. "store.json" means everything
   * lives in the JSON file (mode 0600). "<backend-id> + store.json" means
   * secrets are split out into the OS keychain.
   */
  async secretsLocation(): Promise<string> {
    const kc = await this.getKeychain();
    return kc ? `${kc.id} + store.json` : "store.json";
  }

  async load(): Promise<StoreShape> {
    const primary = await this.readShape(this.path);
    const legacy =
      LEGACY_DIR !== dirname(this.path) ? await this.readShape(join(LEGACY_DIR, "store.json")) : null;
    let state: StoreShape;
    if (!primary && !legacy) state = { version: 1 };
    else if (primary && !legacy) state = primary;
    else if (!primary && legacy) state = legacy;
    else {
      // merge: primary fields win, legacy fills in missing pieces (device + tokens are typically only in legacy
      // during migration; config is the new piece written to primary)
      state = { version: 1 };
      state.device = primary?.device ?? legacy?.device;
      state.tokens = { ...(legacy?.tokens ?? {}), ...(primary?.tokens ?? {}) };
      if (Object.keys(state.tokens).length === 0) delete state.tokens;
      state.config = primary?.config ?? legacy?.config;
      if (!state.config) delete state.config;
    }

    const kc = await this.getKeychain();
    if (kc) await this.hydrateSecretsFromKeychain(state, kc);
    return state;
  }

  private async readShape(path: string): Promise<StoreShape | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      return parsed?.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(state: StoreShape): Promise<void> {
    const kc = await this.getKeychain();
    const onDisk: StoreShape = kc ? await this.stripSecretsToKeychain(state, kc) : state;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(onDisk, null, 2), "utf8");
    try {
      await chmod(this.path, 0o600);
    } catch {
      // best-effort on non-POSIX
    }
  }

  /**
   * Pull secrets out of `state` and into the keychain backend. Returns a deep
   * clone of the state with secret fields blanked so the JSON file no longer
   * contains them. Best-effort: a keychain write failure is logged via thrown
   * error, callers don't have to special-case it (the Store.save catches and
   * logs as needed downstream).
   */
  private async stripSecretsToKeychain(state: StoreShape, kc: KeychainBackend): Promise<StoreShape> {
    const cleaned: StoreShape = JSON.parse(JSON.stringify(state));
    if (cleaned.device?.privateKey) {
      await kc.set("device-private-key", cleaned.device.privateKey);
      cleaned.device = { ...cleaned.device, privateKey: "" };
    }
    if (cleaned.tokens) {
      for (const [gatewayId, entry] of Object.entries(cleaned.tokens)) {
        if (entry?.token) {
          await kc.set(`device-token:${gatewayId}`, entry.token);
          cleaned.tokens[gatewayId] = { ...entry, token: "" };
        }
      }
    }
    if (cleaned.config) {
      if (cleaned.config.gatewayToken) {
        await kc.set("gateway-token", cleaned.config.gatewayToken);
        cleaned.config = { ...cleaned.config, gatewayToken: "" };
      }
      if (cleaned.config.gatewayPassword) {
        await kc.set("gateway-password", cleaned.config.gatewayPassword);
        cleaned.config = { ...cleaned.config, gatewayPassword: "" };
      }
    }
    return cleaned;
  }

  /**
   * Inverse of stripSecretsToKeychain — fills in the secret fields read from
   * the keychain into the in-memory state. A field already populated wins
   * over the keychain (defensive: lets the user override via env or the
   * legacy store.json without surprise).
   */
  private async hydrateSecretsFromKeychain(state: StoreShape, kc: KeychainBackend): Promise<void> {
    if (state.device && !state.device.privateKey) {
      const v = await kc.get("device-private-key");
      if (v) state.device.privateKey = v;
    }
    if (state.tokens) {
      for (const [gatewayId, entry] of Object.entries(state.tokens)) {
        if (entry && !entry.token) {
          const v = await kc.get(`device-token:${gatewayId}`);
          if (v) entry.token = v;
        }
      }
    }
    if (state.config) {
      if (!state.config.gatewayToken) {
        const v = await kc.get("gateway-token");
        if (v) state.config.gatewayToken = v;
      }
      if (!state.config.gatewayPassword) {
        const v = await kc.get("gateway-password");
        if (v) state.config.gatewayPassword = v;
      }
    }
  }

  async loadDevice(): Promise<(DeviceIdentity & { createdAtMs: number }) | undefined> {
    const s = await this.load();
    return s.device;
  }

  async saveDevice(device: DeviceIdentity & { createdAtMs: number }): Promise<void> {
    const s = await this.load();
    s.device = device;
    await this.save(s);
  }

  async loadToken(gatewayId: string): Promise<DeviceTokenEntry | undefined> {
    const s = await this.load();
    return s.tokens?.[gatewayId];
  }

  async saveToken(gatewayId: string, entry: DeviceTokenEntry): Promise<void> {
    const s = await this.load();
    s.tokens = s.tokens ?? {};
    s.tokens[gatewayId] = entry;
    await this.save(s);
  }

  async clearToken(gatewayId: string): Promise<void> {
    const s = await this.load();
    if (s.tokens?.[gatewayId]) {
      delete s.tokens[gatewayId];
      await this.save(s);
    }
    const kc = await this.getKeychain();
    if (kc) await kc.delete(`device-token:${gatewayId}`);
  }

  async loadConfig(): Promise<GatewayConfigShape> {
    const s = await this.load();
    return s.config ?? {};
  }

  async saveConfig(cfg: GatewayConfigShape): Promise<void> {
    const s = await this.load();
    s.config = { ...s.config, ...cfg, savedAtMs: Date.now() };
    await this.save(s);
  }

  async clearConfig(): Promise<void> {
    const s = await this.load();
    if (s.config) {
      delete s.config;
      await this.save(s);
    }
    const kc = await this.getKeychain();
    if (kc) {
      await kc.delete("gateway-token");
      await kc.delete("gateway-password");
    }
  }

  pathInfo(): string {
    return this.path;
  }
}
