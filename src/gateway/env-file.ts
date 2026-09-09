// ADR-006 — File-based secrets: `.env` + `store.json`, no OS keychain.
// See docs/adr/006-env-file-secrets-no-keychain.md.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the config directory that holds `store.json` (and, optionally,
 * `.env`). Lives here rather than in store.ts so the env-file loader can run
 * before anything else imports the Store.
 *
 * Note: the vars consulted here must be *real* environment variables — they
 * decide where the `.env` file is looked up, so setting them inside that same
 * file would be circular.
 */
export function resolveConfigDir(): string {
  const xdgBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return (
    process.env.OPENCLAW_CONTROL_HOME ??
    process.env.OPENCLAW_CLAW_HOME ?? // backward-compat for early adopters
    join(xdgBase, "openclaw-control-mcp")
  );
}

export type EnvFileLoadResult = {
  /** Files that existed and were parsed, in precedence order (first wins). */
  loaded: string[];
  /** Files that were looked at but don't exist. */
  missing: string[];
  /** Keys actually injected into process.env (i.e. not already set). */
  applied: string[];
  /** Non-fatal problems worth surfacing (bad permissions, unreadable file, …). */
  warnings: string[];
};

/**
 * Candidate `.env` paths, highest precedence first:
 *   1. `$OPENCLAW_ENV_FILE` — explicit override, wins over everything
 *   2. `./.env`             — project-local, handy for `npx` in a repo
 *   3. `<configDir>/.env`   — the durable per-user location
 */
export function envFileCandidates(cwd: string = process.cwd()): string[] {
  const explicit = process.env.OPENCLAW_ENV_FILE?.trim();
  const paths = explicit ? [explicit] : [];
  paths.push(join(cwd, ".env"));
  const configPath = join(resolveConfigDir(), ".env");
  if (!paths.includes(configPath)) paths.push(configPath);
  return paths;
}

/**
 * Parse a dotenv-style file. Deliberately minimal — no variable interpolation,
 * no multiline values — so there is no surprising expansion of a secret.
 *
 * Supported:
 *   KEY=value            # trailing comments on unquoted values are stripped
 *   export KEY=value
 *   KEY="value with #"   # double quotes: \n \r \t \\ \" are unescaped
 *   KEY='raw value'      # single quotes: taken literally
 *   # standalone comment
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an unescaped ` #` starts a trailing comment.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load the candidate `.env` files into `process.env`.
 *
 * Precedence: a variable already present in the real environment always wins,
 * then the candidate files in order. Nothing is ever overwritten, so a
 * one-shot `OPENCLAW_GATEWAY_TOKEN=… npx openclaw-control-mcp` still beats the
 * persisted file.
 *
 * Must be called before any module reads `process.env` at import time — see
 * the top of `src/index.ts`.
 */
export function loadEnvFiles(cwd: string = process.cwd()): EnvFileLoadResult {
  const result: EnvFileLoadResult = { loaded: [], missing: [], applied: [], warnings: [] };
  for (const path of envFileCandidates(cwd)) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") result.missing.push(path);
      else result.warnings.push(`could not read ${path}: ${(err as Error).message}`);
      continue;
    }
    result.loaded.push(path);
    warnOnLoosePermissions(path, result);
    for (const [key, value] of Object.entries(parseEnvFile(content))) {
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      result.applied.push(key);
    }
  }
  return result;
}

/**
 * `.env` holds the device private key and gateway tokens — group/other-readable
 * is a real leak on a shared host. We warn instead of refusing so a
 * freshly-copied file doesn't hard-block startup.
 */
function warnOnLoosePermissions(path: string, result: EnvFileLoadResult): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      result.warnings.push(
        `${path} is readable by other users (mode ${(statSync(path).mode & 0o777).toString(8)}) — run \`chmod 600 ${path}\``,
      );
    }
  } catch {
    // stat failure is not worth reporting; the read already succeeded.
  }
}
