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

/** v2 of the on-disk shape — supports multi-instance gateway configs. */
export type StoreShape = {
  version: 1 | 2;
  device?: DeviceIdentity & { createdAtMs: number };
  tokens?: Record<string, DeviceTokenEntry>; // keyed by gatewayId (sha256(url)) — already multi-instance
  // v1 only (legacy single-instance) — auto-migrated to `configs.default` on load.
  config?: GatewayConfigShape;
  // v2: named configs. Used keys are arbitrary ('default', 'work', 'perso', …).
  configs?: Record<string, GatewayConfigShape>;
  // v2: which named instance is the active default for tools that don't pass an `instance` param.
  defaultInstance?: string;
};

export const DEFAULT_INSTANCE = "default";

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
    if (!primary && !legacy) state = { version: 2 };
    else if (primary && !legacy) state = primary;
    else if (!primary && legacy) state = legacy;
    else {
      // merge: primary fields win, legacy fills in missing pieces (device + tokens are typically only in legacy
      // during migration; config is the new piece written to primary)
      state = { version: 2 };
      state.device = primary?.device ?? legacy?.device;
      state.tokens = { ...(legacy?.tokens ?? {}), ...(primary?.tokens ?? {}) };
      if (Object.keys(state.tokens).length === 0) delete state.tokens;
      // For configs: prefer primary's v2 `configs` if present, else migrate from primary.config or legacy.config
      state.configs = primary?.configs ?? legacy?.configs;
      state.defaultInstance = primary?.defaultInstance ?? legacy?.defaultInstance;
      const legacySingle = primary?.config ?? legacy?.config;
      if (legacySingle && !state.configs) {
        state.configs = { [DEFAULT_INSTANCE]: legacySingle };
        state.defaultInstance = DEFAULT_INSTANCE;
      }
    }

    // v1 -> v2 migration: lift `state.config` into `state.configs.default` and drop the singular field.
    if (state.config && !state.configs) {
      state.configs = { [DEFAULT_INSTANCE]: state.config };
      state.defaultInstance = state.defaultInstance ?? DEFAULT_INSTANCE;
    }
    if (state.config) delete state.config;
    state.version = 2;

    const kc = await this.getKeychain();
    if (kc) await this.hydrateSecretsFromKeychain(state, kc);
    return state;
  }

  private async readShape(path: string): Promise<StoreShape | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      // Accept any known version. v1 (legacy single-config) is migrated by load().
      return parsed?.version === 1 || parsed?.version === 2 ? parsed : null;
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
    if (cleaned.configs) {
      for (const [instance, cfg] of Object.entries(cleaned.configs)) {
        if (cfg.gatewayToken) {
          await kc.set(`gateway-token:${instance}`, cfg.gatewayToken);
          cleaned.configs[instance] = { ...cfg, gatewayToken: "" };
        }
        if (cfg.gatewayPassword) {
          await kc.set(`gateway-password:${instance}`, cfg.gatewayPassword);
          cleaned.configs[instance] = { ...cleaned.configs[instance], gatewayPassword: "" };
        }
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
    if (state.configs) {
      for (const [instance, cfg] of Object.entries(state.configs)) {
        if (!cfg.gatewayToken) {
          const v = await kc.get(`gateway-token:${instance}`);
          if (v) cfg.gatewayToken = v;
          // Legacy fallback: pre-0.4.0 keychain entries used un-namespaced keys.
          else if (instance === DEFAULT_INSTANCE) {
            const legacy = await kc.get("gateway-token");
            if (legacy) cfg.gatewayToken = legacy;
          }
        }
        if (!cfg.gatewayPassword) {
          const v = await kc.get(`gateway-password:${instance}`);
          if (v) cfg.gatewayPassword = v;
          else if (instance === DEFAULT_INSTANCE) {
            const legacy = await kc.get("gateway-password");
            if (legacy) cfg.gatewayPassword = legacy;
          }
        }
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

  /**
   * Returns the full multi-instance config map, keyed by instance name. Useful
   * for setup tools that need to enumerate everything (`openclaw_setup_list`).
   */
  async loadConfigs(): Promise<{
    configs: Record<string, GatewayConfigShape>;
    defaultInstance: string;
  }> {
    const s = await this.load();
    return {
      configs: s.configs ?? {},
      defaultInstance: s.defaultInstance ?? DEFAULT_INSTANCE,
    };
  }

  /**
   * Read one named instance's config. If `instance` is omitted, reads the
   * current default. Returns `{}` if the requested instance doesn't exist.
   */
  async loadConfig(instance?: string): Promise<GatewayConfigShape> {
    const s = await this.load();
    const name = instance ?? s.defaultInstance ?? DEFAULT_INSTANCE;
    return s.configs?.[name] ?? {};
  }

  /**
   * Write / merge a config into a named instance. Default instance name is
   * "default" (matches the v1 → v2 migration), so legacy callers that don't
   * pass `instance` keep working.
   */
  async saveConfig(cfg: GatewayConfigShape, instance: string = DEFAULT_INSTANCE): Promise<void> {
    const s = await this.load();
    s.configs = s.configs ?? {};
    s.configs[instance] = { ...(s.configs[instance] ?? {}), ...cfg, savedAtMs: Date.now() };
    if (!s.defaultInstance) s.defaultInstance = instance;
    await this.save(s);
  }

  /**
   * Clear one specific instance, or all of them if `instance` is omitted. Also
   * clears the matching keychain secrets when keychain is active. If the
   * cleared instance was the default and other instances still exist, picks an
   * arbitrary remaining one as the new default.
   */
  async clearConfig(instance?: string): Promise<void> {
    const s = await this.load();
    // Capture instance names BEFORE we mutate state, so we know which keychain entries to wipe.
    const knownInstances = Object.keys(s.configs ?? {});
    let touched = false;
    if (instance == null) {
      // Clear everything.
      if (s.configs) {
        delete s.configs;
        delete s.defaultInstance;
        touched = true;
      }
    } else if (s.configs?.[instance]) {
      delete s.configs[instance];
      if (s.defaultInstance === instance) {
        const remaining = Object.keys(s.configs);
        s.defaultInstance = remaining[0];
      }
      if (Object.keys(s.configs).length === 0) {
        delete s.configs;
        delete s.defaultInstance;
      }
      touched = true;
    }
    if (touched) await this.save(s);

    const kc = await this.getKeychain();
    if (!kc) return;
    if (instance == null) {
      // Best-effort: forget every namespaced + legacy secret for configs we knew about.
      const keysToDelete = new Set<string>(["gateway-token", "gateway-password"]);
      for (const inst of knownInstances) {
        keysToDelete.add(`gateway-token:${inst}`);
        keysToDelete.add(`gateway-password:${inst}`);
      }
      for (const k of keysToDelete) await kc.delete(k);
    } else {
      await kc.delete(`gateway-token:${instance}`);
      await kc.delete(`gateway-password:${instance}`);
      if (instance === DEFAULT_INSTANCE) {
        // Also wipe any legacy un-namespaced entries, just in case.
        await kc.delete("gateway-token");
        await kc.delete("gateway-password");
      }
    }
  }

  async setDefaultInstance(instance: string): Promise<void> {
    const s = await this.load();
    if (!s.configs?.[instance]) {
      throw new Error(`unknown instance '${instance}' — use openclaw_setup to create it first`);
    }
    s.defaultInstance = instance;
    await this.save(s);
  }

  pathInfo(): string {
    return this.path;
  }
}
