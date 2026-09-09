import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  envFileCandidates,
  loadEnvFiles,
  parseEnvFile,
  resolveConfigDir,
} from "../src/gateway/env-file.js";

let dir: string;
const TOUCHED = [
  "OPENCLAW_ENV_FILE",
  "OPENCLAW_CONTROL_HOME",
  "OPENCLAW_CLAW_HOME",
  "XDG_CONFIG_HOME",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_DEVICE_TOKEN",
  "TEST_ENVFILE_KEY",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-envfile-"));
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  // Point the config-dir candidate at the throwaway dir so a real
  // ~/.config/openclaw-control-mcp/.env on the dev box can't leak in.
  process.env.OPENCLAW_CONTROL_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("parseEnvFile", () => {
  it("parses plain, exported, quoted and commented lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "OPENCLAW_GATEWAY_URL=wss://gw.example/ws",
        "export OPENCLAW_GATEWAY_TOKEN=tok-123",
        'QUOTED="value with # hash"',
        "SINGLE='raw $value'",
        "TRAILING=abc # inline comment",
        "ESCAPES=\"line1\\nline2\"",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      OPENCLAW_GATEWAY_URL: "wss://gw.example/ws",
      OPENCLAW_GATEWAY_TOKEN: "tok-123",
      QUOTED: "value with # hash",
      SINGLE: "raw $value",
      TRAILING: "abc",
      ESCAPES: "line1\nline2",
    });
  });

  it("ignores malformed keys and lines without '='", () => {
    const parsed = parseEnvFile(["not-an-assignment", "=novalue", "1BAD=x", "  ", "OK=1"].join("\n"));
    expect(parsed).toEqual({ OK: "1" });
  });

  it("does not interpolate variables — a secret is taken literally", () => {
    expect(parseEnvFile("A=$HOME/x")).toEqual({ A: "$HOME/x" });
  });
});

describe("envFileCandidates", () => {
  it("puts OPENCLAW_ENV_FILE first, then cwd/.env, then the config dir", () => {
    process.env.OPENCLAW_ENV_FILE = "/explicit/.env";
    process.env.OPENCLAW_CONTROL_HOME = "/cfg";
    expect(envFileCandidates("/work")).toEqual(["/explicit/.env", "/work/.env", "/cfg/.env"]);
  });

  it("does not list the same path twice when cwd is the config dir", () => {
    process.env.OPENCLAW_CONTROL_HOME = "/work";
    expect(envFileCandidates("/work")).toEqual(["/work/.env"]);
  });

  it("resolveConfigDir honours OPENCLAW_CONTROL_HOME then XDG_CONFIG_HOME", () => {
    delete process.env.OPENCLAW_CONTROL_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(resolveConfigDir()).toBe("/xdg/openclaw-control-mcp");
    process.env.OPENCLAW_CONTROL_HOME = "/override";
    expect(resolveConfigDir()).toBe("/override");
  });
});

describe("loadEnvFiles", () => {
  it("injects values into process.env", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "OPENCLAW_GATEWAY_URL=wss://from-file\nTEST_ENVFILE_KEY=42\n");
    chmodSync(file, 0o600);
    process.env.OPENCLAW_ENV_FILE = file;

    const result = loadEnvFiles(dir);
    expect(result.loaded).toContain(file);
    expect(result.applied).toContain("OPENCLAW_GATEWAY_URL");
    expect(process.env.OPENCLAW_GATEWAY_URL).toBe("wss://from-file");
    expect(process.env.TEST_ENVFILE_KEY).toBe("42");
    expect(result.warnings).toEqual([]);
  });

  it("never overrides a variable already present in the real environment", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "OPENCLAW_GATEWAY_TOKEN=from-file\n");
    chmodSync(file, 0o600);
    process.env.OPENCLAW_ENV_FILE = file;
    process.env.OPENCLAW_GATEWAY_TOKEN = "from-real-env";

    const result = loadEnvFiles(dir);
    expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("from-real-env");
    expect(result.applied).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("earlier candidates win over later ones", () => {
    const explicit = join(dir, "explicit.env");
    const local = join(dir, ".env");
    writeFileSync(explicit, "OPENCLAW_DEVICE_TOKEN=explicit\n");
    writeFileSync(local, "OPENCLAW_DEVICE_TOKEN=local\nTEST_ENVFILE_KEY=only-local\n");
    chmodSync(explicit, 0o600);
    chmodSync(local, 0o600);
    process.env.OPENCLAW_ENV_FILE = explicit;

    loadEnvFiles(dir);
    expect(process.env.OPENCLAW_DEVICE_TOKEN).toBe("explicit");
    // Later files still fill in keys the earlier one didn't define.
    expect(process.env.TEST_ENVFILE_KEY).toBe("only-local");
  });

  it("reports missing files without throwing", () => {
    process.env.OPENCLAW_ENV_FILE = join(dir, "nope.env");
    const result = loadEnvFiles(dir);
    expect(result.loaded).toEqual([]);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it("warns when the file is readable by other users", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "TEST_ENVFILE_KEY=1\n");
    chmodSync(file, 0o644);
    process.env.OPENCLAW_ENV_FILE = file;

    const result = loadEnvFiles(dir);
    expect(result.warnings.join(" ")).toContain("chmod 600");
    // Still loaded — a permissions warning must not block startup.
    expect(process.env.TEST_ENVFILE_KEY).toBe("1");
  });
});
