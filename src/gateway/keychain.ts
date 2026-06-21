import { spawnSync } from "node:child_process";
import { platform, userInfo } from "node:os";

/**
 * Minimal OS-keychain backend for storing per-device secrets out of
 * `~/.config/openclaw-control-mcp/store.json` (which is only mode 0600 — fine
 * against other local users, weak against any process running as you).
 *
 *   - macOS: shells out to the built-in `security` CLI (no extra dep)
 *   - Linux: shells out to `secret-tool` if installed (libsecret)
 *   - Windows / no-keychain-available: returns null on read, throws on write
 *     (the Store catches and falls back to plain JSON)
 *
 * Default ON since 0.5.0 — set `OPENCLAW_USE_KEYCHAIN=0` to opt out and keep
 * everything in `store.json` mode 0600 (the 0.3.x / 0.4.x default). Migration
 * is lazy: existing 0.4.x users on plain JSON keep working until the next
 * Store.save() (typically the next gateway connect that refreshes the device
 * token), at which point secrets move to the keychain automatically.
 *
 * Keys are namespaced as `openclaw-control-mcp:<scope>` to avoid collisions
 * with other apps. Values are arbitrary strings (we serialise the secret —
 * the Ed25519 private key, the device token, etc. — as base64url already).
 */
export interface KeychainBackend {
  /** Human-readable backend identifier ("macos-security", "libsecret", "noop"). */
  readonly id: string;
  /** Whether the backend is actually usable on this host (CLI present, etc.). */
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_PREFIX = "openclaw-control-mcp:";
const namespacedKey = (key: string): string =>
  key.startsWith(KEY_PREFIX) ? key : `${KEY_PREFIX}${key}`;

class MacosSecurityBackend implements KeychainBackend {
  readonly id = "macos-security";
  private account = userInfo().username;

  async isAvailable(): Promise<boolean> {
    if (platform() !== "darwin") return false;
    const result = spawnSync("security", ["help"], { encoding: "utf8" });
    return result.status === 0 || result.status === 1; // `security help` returns 1 but proves it's there
  }

  async get(key: string): Promise<string | null> {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-a", this.account, "-s", namespacedKey(key), "-w"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim();
  }

  async set(key: string, value: string): Promise<void> {
    // SECURITY: pass the secret on stdin, never as a CLI argument — argv is
    // world-readable via `ps`/`/proc`. With `-w` and no inline value, the
    // `security` tool reads the password from stdin (mirrors the libsecret
    // backend, which already pipes via `input`).
    const result = spawnSync(
      "security",
      [
        "add-generic-password",
        "-a",
        this.account,
        "-s",
        namespacedKey(key),
        "-w", // no value: read the password from stdin
        "-U", // update if exists
        "-T",
        "/usr/bin/security", // allow `security` itself to read without prompting
      ],
      { input: value, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`macos keychain set failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async delete(key: string): Promise<void> {
    spawnSync("security", ["delete-generic-password", "-a", this.account, "-s", namespacedKey(key)], {
      encoding: "utf8",
    });
    // Ignore exit status: not-found is fine, just means already gone.
  }
}

class LibsecretBackend implements KeychainBackend {
  readonly id = "libsecret";

  async isAvailable(): Promise<boolean> {
    if (platform() !== "linux") return false;
    const result = spawnSync("secret-tool", ["--version"], { encoding: "utf8" });
    return result.status === 0;
  }

  async get(key: string): Promise<string | null> {
    const result = spawnSync(
      "secret-tool",
      ["lookup", "service", namespacedKey(key)],
      { encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    const value = result.stdout;
    return value.length > 0 ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    const result = spawnSync(
      "secret-tool",
      ["store", "--label", namespacedKey(key), "service", namespacedKey(key)],
      { input: value, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`libsecret set failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async delete(key: string): Promise<void> {
    spawnSync("secret-tool", ["clear", "service", namespacedKey(key)], { encoding: "utf8" });
    // Ignore exit status.
  }
}

class NoopBackend implements KeychainBackend {
  readonly id = "noop";
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {
    throw new Error("keychain backend not available on this platform");
  }
  async delete(): Promise<void> {
    // No-op.
  }
}

/**
 * Resolve the best keychain backend for this host. Returns a Noop when none is
 * available so callers don't have to null-check.
 */
export async function resolveKeychainBackend(): Promise<KeychainBackend> {
  const candidates = [new MacosSecurityBackend(), new LibsecretBackend()];
  for (const backend of candidates) {
    if (await backend.isAvailable()) return backend;
  }
  return new NoopBackend();
}

/**
 * Convenience helper used by `Store`: returns the keychain backend when one
 * is usable AND the user hasn't opted out. Default ON since 0.5.0 — set
 * `OPENCLAW_USE_KEYCHAIN=0` (or "false") to keep secrets in plain JSON.
 * Returns null when no usable backend exists (no keychain CLI installed) so
 * the Store falls back to plain `store.json` mode 0600.
 */
export async function maybeKeychainBackend(): Promise<KeychainBackend | null> {
  const flag = process.env.OPENCLAW_USE_KEYCHAIN;
  if (flag === "0" || flag === "false") return null;
  const backend = await resolveKeychainBackend();
  if (backend.id === "noop") return null;
  return backend;
}
