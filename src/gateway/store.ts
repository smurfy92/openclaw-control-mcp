import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { DeviceIdentity } from "./device.js";

export type DeviceTokenEntry = {
  token: string;
  role: string;
  scopes: string[];
  savedAtMs: number;
};

export type StoreShape = {
  version: 1;
  device?: DeviceIdentity & { createdAtMs: number };
  tokens?: Record<string, DeviceTokenEntry>;
};

const DEFAULT_DIR = process.env.OPENCLAW_CLAW_HOME
  ? process.env.OPENCLAW_CLAW_HOME
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openclaw-claw-mcp");

export class Store {
  private path: string;
  private cache: StoreShape | null = null;

  constructor(dir: string = DEFAULT_DIR, fileName: string = "store.json") {
    this.path = join(dir, fileName);
  }

  static gatewayId(url: string): string {
    return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
  }

  async load(): Promise<StoreShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      this.cache = parsed?.version === 1 ? parsed : { version: 1 };
    } catch {
      this.cache = { version: 1 };
    }
    return this.cache;
  }

  async save(state: StoreShape): Promise<void> {
    this.cache = state;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), "utf8");
    try {
      await chmod(this.path, 0o600);
    } catch {
      // best-effort on non-POSIX
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
  }

  pathInfo(): string {
    return this.path;
  }
}
