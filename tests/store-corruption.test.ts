import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/gateway/store.js";

let dir: string;
let store: Store;
let storePath: string;
let stderr: string[];
let originalWrite: typeof process.stderr.write;

const GOOD_STORE = {
  version: 2,
  device: { deviceId: "dev-1", publicKey: "PUB", privateKey: "PRIV", createdAtMs: 1 },
  tokens: { abc: { token: "TOK", role: "operator", scopes: [], savedAtMs: 1 } },
  configs: { default: { gatewayUrl: "wss://gw" } },
  defaultInstance: "default",
};

beforeEach(() => {
  // Temp dir only — the real ~/.config store is never read or written here.
  dir = mkdtempSync(join(tmpdir(), "openclaw-corrupt-"));
  store = new Store(dir, "store.json");
  storePath = join(dir, "store.json");
  stderr = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  rmSync(dir, { recursive: true, force: true });
});

function corruptFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("store.json.corrupt-"));
}

describe("Store corruption handling", () => {
  it("treats an absent store as empty, silently, without creating a quarantine file", async () => {
    const state = await store.load();
    expect(state).toEqual({ version: 2 });
    expect(stderr).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("quarantines an invalid-JSON store instead of overwriting it", async () => {
    writeFileSync(storePath, '{"version": 2, "device": {"privateKey": "PRIV-KEY-DO-NOT-LOSE"', "utf8");
    chmodSync(storePath, 0o600);

    const state = await store.load();
    expect(state).toEqual({ version: 2 }); // continue with an empty store

    const moved = corruptFiles();
    expect(moved).toHaveLength(1);
    // The original bytes survive, so the private key can be recovered by hand.
    expect(readFileSync(join(dir, moved[0]), "utf8")).toContain("PRIV-KEY-DO-NOT-LOSE");
    // `rename` preserves the file mode.
    expect(statSync(join(dir, moved[0])).mode & 0o777).toBe(0o600);
    expect(stderr.join("")).toMatch(/invalid JSON/);
    // The warning never echoes the content of the file.
    expect(stderr.join("")).not.toContain("PRIV-KEY-DO-NOT-LOSE");
  });

  it("quarantines a store whose version is unknown", async () => {
    writeFileSync(storePath, JSON.stringify({ ...GOOD_STORE, version: 99 }), "utf8");

    await store.load();
    expect(corruptFiles()).toHaveLength(1);
    expect(stderr.join("")).toMatch(/unknown store version/);
  });

  it("does not let the next save clobber a corrupted store", async () => {
    writeFileSync(storePath, "not json at all", "utf8");

    await store.saveConfig({ gatewayUrl: "wss://new-gw" });

    const moved = corruptFiles();
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(dir, moved[0]), "utf8")).toBe("not json at all");
    const written = JSON.parse(readFileSync(storePath, "utf8")) as { configs: Record<string, unknown> };
    expect(written.configs.default).toMatchObject({ gatewayUrl: "wss://new-gw" });
  });

  it("leaves a valid store untouched", async () => {
    writeFileSync(storePath, JSON.stringify(GOOD_STORE), "utf8");

    const state = await store.load();
    expect(state.device?.privateKey).toBe("PRIV");
    expect(corruptFiles()).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("still migrates a v1 store without quarantining it", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, config: { gatewayUrl: "wss://legacy" } }),
      "utf8",
    );

    const state = await store.load();
    expect(state.version).toBe(2);
    expect(state.configs?.default.gatewayUrl).toBe("wss://legacy");
    expect(corruptFiles()).toEqual([]);
  });
});
