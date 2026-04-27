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

const XDG_BASE = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const LEGACY_DIR = join(XDG_BASE, "openclaw-claw-mcp");
const DEFAULT_DIR =
  process.env.OPENCLAW_CONTROL_HOME ??
  process.env.OPENCLAW_CLAW_HOME ?? // backward-compat for early adopters
  join(XDG_BASE, "openclaw-control-mcp");

export class Store {
  private path: string;

  constructor(dir: string = DEFAULT_DIR, fileName: string = "store.json") {
    this.path = join(dir, fileName);
  }

  static gatewayId(url: string): string {
    return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
  }

  async load(): Promise<StoreShape> {
    const raw = await this.readPrimaryOrLegacy();
    if (!raw) return { version: 1 };
    try {
      const parsed = JSON.parse(raw) as StoreShape;
      return parsed?.version === 1 ? parsed : { version: 1 };
    } catch {
      return { version: 1 };
    }
  }

  private async readPrimaryOrLegacy(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch {
      // fall through to legacy
    }
    if (LEGACY_DIR !== dirname(this.path)) {
      try {
        return await readFile(join(LEGACY_DIR, "store.json"), "utf8");
      } catch {
        // no legacy either
      }
    }
    return null;
  }

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
