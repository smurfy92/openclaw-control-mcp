// ADR-006 — File-based secrets. This module is the *only* place that still
// touches an OS keychain, it is READ-ONLY, and it runs exclusively behind the
// explicit `--migrate-from-keychain` CLI flag. Nothing on the normal startup
// path imports it.
//
// Releases 0.5.0 → 0.7.0 stored secrets in the OS keychain (macOS `security`,
// Linux `secret-tool`) and left blank fields in `store.json`. Upgrading to
// 0.8.0 without a migration would leave those users with an empty
// `device.privateKey` and force a re-pair. This importer reads the keychain
// once, writes the values back into `store.json` (mode 0600), and prints the
// commands to delete the now-unused keychain items — the user runs those
// themselves, so we never delete anything from their keychain.
import { spawnSync } from "node:child_process";
import { platform, userInfo } from "node:os";
import { Store } from "./store.js";

const KEY_PREFIX = "openclaw-control-mcp:";
const BUNDLE_KEY = "secrets-bundle";
const namespaced = (key: string): string => `${KEY_PREFIX}${key}`;

type LegacyBundle = {
  version: 1;
  device?: { privateKey: string };
  tokens?: Record<string, string>;
  configs?: Record<string, { gatewayToken?: string; gatewayPassword?: string }>;
};

type Reader = { id: string; get(key: string): string | null };

/** Read-only view of whichever keychain CLI exists on this host, or null. */
export function resolveReader(): Reader | null {
  if (platform() === "darwin") {
    const probe = spawnSync("security", ["help"], { encoding: "utf8" });
    // `security help` exits 1 but proves the binary is there.
    if (probe.status === 0 || probe.status === 1) {
      const account = userInfo().username;
      return {
        id: "macos-security",
        get(key) {
          const r = spawnSync(
            "security",
            ["find-generic-password", "-a", account, "-s", namespaced(key), "-w"],
            { encoding: "utf8" },
          );
          return r.status === 0 ? r.stdout.trim() || null : null;
        },
      };
    }
  }
  if (platform() === "linux") {
    const probe = spawnSync("secret-tool", ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return {
        id: "libsecret",
        get(key) {
          const r = spawnSync("secret-tool", ["lookup", "service", namespaced(key)], {
            encoding: "utf8",
          });
          return r.status === 0 ? r.stdout || null : null;
        },
      };
    }
  }
  return null;
}

export type MigrationReport = {
  ok: boolean;
  backend: string | null;
  /** Fields written into store.json. */
  imported: string[];
  /** Keychain items that still hold a copy, with the command to delete them. */
  leftoverItems: string[];
  message: string;
};

/**
 * One-shot import. Reads the 0.6.1+ single-item bundle first, then falls back
 * to the pre-0.6.1 per-secret items. Only fills fields that are currently
 * empty in `store.json` — running it twice is a no-op.
 */
export async function migrateFromKeychain(
  store: Store,
  // Injectable so tests can exercise the import without an OS keychain.
  reader: Reader | null = resolveReader(),
): Promise<MigrationReport> {
  if (!reader) {
    return {
      ok: false,
      backend: null,
      imported: [],
      leftoverItems: [],
      message:
        "No OS keychain CLI found on this host (macOS `security` / Linux `secret-tool`). Nothing to migrate.",
    };
  }

  const state = await store.load();
  const secrets = readBundle(reader) ?? readLegacyItems(reader, state);
  if (!secrets) {
    return {
      ok: false,
      backend: reader.id,
      imported: [],
      leftoverItems: [],
      message: `No openclaw-control-mcp secrets found in the ${reader.id} keychain. Nothing to migrate.`,
    };
  }

  const imported = await store.importSecrets(secrets);
  const leftoverItems = itemsToDelete(reader, state);
  return {
    ok: true,
    backend: reader.id,
    imported,
    leftoverItems,
    message:
      imported.length > 0
        ? `Imported ${imported.length} secret(s) into ${store.pathInfo()} (mode 0600). ` +
          "The keychain copies are now unused — delete them with the commands under `leftoverItems`."
        : "Nothing to import: store.json already holds every secret. " +
          "The keychain copies are unused — delete them with the commands under `leftoverItems`.",
  };
}

function readBundle(reader: Reader): LegacyBundle | null {
  const raw = reader.get(BUNDLE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LegacyBundle;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Pre-0.6.1 layout: one keychain item per secret. */
function readLegacyItems(
  reader: Reader,
  state: { tokens?: Record<string, unknown>; configs?: Record<string, unknown> },
): LegacyBundle | null {
  const out: LegacyBundle = { version: 1 };
  const priv = reader.get("device-private-key");
  if (priv) out.device = { privateKey: priv };
  for (const gatewayId of Object.keys(state.tokens ?? {})) {
    const token = reader.get(`device-token:${gatewayId}`);
    if (token) (out.tokens ??= {})[gatewayId] = token;
  }
  for (const instance of Object.keys(state.configs ?? {})) {
    const gatewayToken =
      reader.get(`gateway-token:${instance}`) ??
      (instance === "default" ? reader.get("gateway-token") : null);
    const gatewayPassword =
      reader.get(`gateway-password:${instance}`) ??
      (instance === "default" ? reader.get("gateway-password") : null);
    if (gatewayToken || gatewayPassword) {
      (out.configs ??= {})[instance] = {
        ...(gatewayToken ? { gatewayToken } : {}),
        ...(gatewayPassword ? { gatewayPassword } : {}),
      };
    }
  }
  return out.device || out.tokens || out.configs ? out : null;
}

/**
 * The delete commands we *suggest*; we never run them. Only items that
 * actually exist are listed, so the output is copy-pasteable as-is.
 */
function itemsToDelete(
  reader: Reader,
  state: { tokens?: Record<string, unknown>; configs?: Record<string, unknown> },
): string[] {
  const keys = [
    BUNDLE_KEY,
    "device-private-key",
    "gateway-token",
    "gateway-password",
    ...Object.keys(state.tokens ?? {}).map((id) => `device-token:${id}`),
    ...Object.keys(state.configs ?? {}).flatMap((i) => [`gateway-token:${i}`, `gateway-password:${i}`]),
  ];
  const account = userInfo().username;
  return keys
    .filter((k) => reader.get(k) !== null)
    .map((k) =>
      reader.id === "macos-security"
        ? `security delete-generic-password -a ${account} -s ${namespaced(k)}`
        : `secret-tool clear service ${namespaced(k)}`,
    );
}
