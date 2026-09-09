// ADR-001 — Multi-instance Store with keychain-backed secrets (keychain part superseded by ADR-006).
// See docs/adr/001-multi-instance-store-with-keychain-backed-secrets.md.
// ADR-006 — File-based secrets (.env + store.json), no OS keychain. See docs/adr/006-env-file-secrets-no-keychain.md.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { type DeviceIdentity, fromBase64Url, toBase64Url } from "./device.js";
import { resolveConfigDir } from "./env-file.js";

const DEFAULT_DEVICE_SCOPES = ["operator.admin", "operator.read", "operator.write"];

/**
 * Read a runtime-injected device identity from env vars. Only
 * OPENCLAW_DEVICE_PRIVATE_KEY is required — publicKey + deviceId are derived
 * from it so callers can rotate a single secret. Enables stateless CI / service
 * accounts where there's no on-disk store to persist a paired device. Returns
 * undefined when the env var is absent so the regular store-based flow runs.
 */
export async function loadDeviceFromEnv(): Promise<
  (DeviceIdentity & { createdAtMs: number }) | undefined
> {
  const priv = process.env.OPENCLAW_DEVICE_PRIVATE_KEY?.trim();
  if (!priv) return undefined;
  const privBytes = fromBase64Url(priv);
  if (privBytes.length !== 32) {
    throw new Error(
      `OPENCLAW_DEVICE_PRIVATE_KEY must be a base64url-encoded 32-byte Ed25519 seed (got ${privBytes.length} bytes after decoding)`,
    );
  }
  const pubBytes = await ed.getPublicKeyAsync(privBytes);
  const publicKey = toBase64Url(pubBytes);
  const deviceId = createHash("sha256").update(pubBytes).digest("hex");
  return { deviceId, publicKey, privateKey: priv, createdAtMs: Date.now() };
}

/**
 * Read a runtime-injected device token from env vars. Pairs with
 * loadDeviceFromEnv for stateless CI: the operator pre-pairs a device and
 * stores the resulting privateKey + token as secrets. OPENCLAW_DEVICE_TOKEN is
 * the only required field; role + scopes fall back to operator defaults.
 */
export function loadTokenFromEnv(): DeviceTokenEntry | undefined {
  const token = process.env.OPENCLAW_DEVICE_TOKEN?.trim();
  if (!token) return undefined;
  const role = process.env.OPENCLAW_DEVICE_ROLE?.trim() || "operator";
  const rawScopes = process.env.OPENCLAW_DEVICE_SCOPES?.trim();
  const scopes = rawScopes
    ? rawScopes.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_DEVICE_SCOPES];
  return { token, role, scopes, savedAtMs: Date.now() };
}

export type DeviceTokenEntry = {
  token: string;
  role: string;
  scopes: string[];
  savedAtMs: number;
};

type GatewayConfigShape = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  timeoutMs?: number;
  savedAtMs?: number;
};

/** v2 of the on-disk shape — supports multi-instance gateway configs. */
type StoreShape = {
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
const DEFAULT_DIR = resolveConfigDir();

/** Env vars that can supply a secret without ever touching `store.json`. */
const SECRET_ENV_VARS = [
  "OPENCLAW_DEVICE_PRIVATE_KEY",
  "OPENCLAW_DEVICE_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
] as const;

export class Store {
  private path: string;

  constructor(dir: string = DEFAULT_DIR, fileName: string = "store.json") {
    this.path = join(dir, fileName);
  }

  static gatewayId(url: string): string {
    return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
  }

  /**
   * Human-readable description of where secrets come from, for
   * `openclaw_setup_show` / `--health`. Since 0.8.0 there is no OS keychain:
   * secrets live in `store.json` (mode 0600) and/or in the environment —
   * typically injected from a `.env` file (see `src/gateway/env-file.ts`).
   */
  secretsLocation(): string {
    const fromEnv = SECRET_ENV_VARS.filter((k) => process.env[k]?.trim());
    const file = `${this.path} (mode 0600)`;
    return fromEnv.length > 0 ? `env: ${fromEnv.join(", ")} + ${file}` : file;
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

  /**
   * Persist the store as JSON, then tighten the file mode to 0600. Secrets are
   * written in the clear inside that file — the same trade-off every CLI that
   * keeps a `~/.netrc`-style credential file makes, and the documented
   * alternative is to keep them in a `.env` instead (see ADR-006).
   */
  async save(state: StoreShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), "utf8");
    try {
      await chmod(this.path, 0o600);
    } catch {
      // best-effort on non-POSIX
    }
  }

  async loadDevice(): Promise<(DeviceIdentity & { createdAtMs: number }) | undefined> {
    const fromEnv = await loadDeviceFromEnv();
    if (fromEnv) return fromEnv;
    const s = await this.load();
    return s.device;
  }

  async saveDevice(device: DeviceIdentity & { createdAtMs: number }): Promise<void> {
    const s = await this.load();
    s.device = device;
    await this.save(s);
  }

  async loadToken(gatewayId: string): Promise<DeviceTokenEntry | undefined> {
    const fromEnv = loadTokenFromEnv();
    if (fromEnv) return fromEnv;
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
   * Clear one specific instance, or all of them if `instance` is omitted. If
   * the cleared instance was the default and other instances still exist,
   * picks an arbitrary remaining one as the new default.
   */
  async clearConfig(instance?: string): Promise<void> {
    const s = await this.load();
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
  }

  /**
   * Fill in secret fields that are currently empty, without touching anything
   * already populated. Used by the one-shot `--migrate-from-keychain` import
   * (0.7.x and older stored secrets in the OS keychain and left blanks in
   * `store.json`); also a clean seam for any future import path.
   *
   * Returns the list of fields it actually wrote, so callers can report
   * precisely what moved.
   */
  async importSecrets(secrets: {
    device?: { privateKey?: string };
    tokens?: Record<string, string>;
    configs?: Record<string, { gatewayToken?: string; gatewayPassword?: string }>;
  }): Promise<string[]> {
    const s = await this.load();
    const applied: string[] = [];
    if (s.device && !s.device.privateKey && secrets.device?.privateKey) {
      s.device.privateKey = secrets.device.privateKey;
      applied.push("device.privateKey");
    }
    if (s.tokens && secrets.tokens) {
      for (const [gatewayId, entry] of Object.entries(s.tokens)) {
        const token = secrets.tokens[gatewayId];
        if (entry && !entry.token && token) {
          entry.token = token;
          applied.push(`tokens.${gatewayId}`);
        }
      }
    }
    if (s.configs && secrets.configs) {
      for (const [instance, cfg] of Object.entries(s.configs)) {
        const slot = secrets.configs[instance];
        if (!slot) continue;
        if (!cfg.gatewayToken && slot.gatewayToken) {
          cfg.gatewayToken = slot.gatewayToken;
          applied.push(`configs.${instance}.gatewayToken`);
        }
        if (!cfg.gatewayPassword && slot.gatewayPassword) {
          cfg.gatewayPassword = slot.gatewayPassword;
          applied.push(`configs.${instance}.gatewayPassword`);
        }
      }
    }
    if (applied.length > 0) await this.save(s);
    return applied;
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

  /**
   * Check whether the persisted device identity is usable. Returns:
   *   - "ok"                 — device exists and privateKey is non-empty
   *   - "no-device"          — no device at all (fresh install)
   *   - "missing-private-key" — device.publicKey set but privateKey lost
   *                             (the bug from docs/troubleshooting/empty-private-key.md)
   */
  async deviceIntegrity(): Promise<"ok" | "no-device" | "missing-private-key"> {
    const s = await this.load();
    if (!s.device) return "no-device";
    if (!s.device.privateKey || s.device.privateKey.length === 0) return "missing-private-key";
    return "ok";
  }

  /**
   * Wipe the broken device + cached gateway tokens. Backs up the current
   * `store.json` to `store.json.bak.<ts>` so the user can recover if needed.
   * Configs (gatewayUrl, gatewayToken, gatewayPassword) are preserved — the
   * user re-uses them on the next setup.
   *
   * After this, the next `connect()` regenerates a fresh keypair and
   * surfaces a new pendingPairing.requestId. The orphaned approved device on
   * the gateway side becomes harmless (its token is never used) but the user
   * should revoke it from the Control panel for cleanliness.
   */
  async repairDevice(): Promise<{ backupPath: string | null; wiped: { device: boolean; tokenCount: number } }> {
    const beforeState = await this.load();
    const hadDevice = !!beforeState.device;
    const tokenIds = Object.keys(beforeState.tokens ?? {});

    // Backup the on-disk JSON (best-effort — no backup if file doesn't exist).
    let backupPath: string | null = `${this.path}.bak.${Date.now()}`;
    try {
      const raw = await readFile(this.path, "utf8");
      await writeFile(backupPath, raw, "utf8");
      try {
        await chmod(backupPath, 0o600);
      } catch {
        /* best-effort on non-POSIX */
      }
    } catch {
      backupPath = null;
    }

    // Drop device + tokens from in-memory state and write back.
    delete beforeState.device;
    beforeState.tokens = {};
    await this.save(beforeState);

    return { backupPath, wiped: { device: hadDevice, tokenCount: tokenIds.length } };
  }
}

/**
 * Per-field credential merge. Env wins when set; store fills in the rest.
 * Empty strings in the store (e.g. post-wipe state where `gatewayToken: ""`)
 * are treated as missing so a freshly-set env var still does what users
 * expect. Pure function — no I/O — so it's trivially testable.
 *
 * Used by `ensureClient` in `src/index.ts` to fix the pre-0.6.2 surprise
 * where setting only `OPENCLAW_GATEWAY_TOKEN` (without `OPENCLAW_GATEWAY_URL`)
 * silently kept the empty store token and sent `auth: {}` to the gateway.
 */
export function mergeCreds(
  env: { token?: string; password?: string },
  storeCfg: { gatewayToken?: string; gatewayPassword?: string },
): { token: string | undefined; password: string | undefined } {
  return {
    token: env.token ?? (storeCfg.gatewayToken || undefined),
    password: env.password ?? (storeCfg.gatewayPassword || undefined),
  };
}
