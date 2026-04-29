import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { generateDevice, signConnect, verifyDeviceId, type DeviceIdentity } from "./device.js";
import { Store, type DeviceTokenEntry } from "./store.js";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientVersion?: string;
  clientMode?: string;
  instanceId?: string;
  timeoutMs?: number;
  store?: Store;
  debug?: (msg: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type ReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown; retryable?: boolean; retryAfterMs?: number };
};
type EventFrame = { type: "event"; event: string; payload?: { nonce?: string; [k: string]: unknown }; seq?: number };

type ConnectAuthResponse = {
  deviceToken?: string;
  role?: string;
  scopes?: string[];
};

type HelloOkPayload = {
  type?: string;
  protocol?: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  auth?: ConnectAuthResponse;
  [k: string]: unknown;
};

export type PairingPending = {
  requestId: string;
  reason?: string;
  detectedAtMs: number;
};

const DEFAULT_SCOPES = ["operator.read", "operator.write", "operator.admin"];
const CLIENT_ID = "openclaw-ios";

export class GatewayError extends Error {
  code?: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
  constructor(opts: { code?: string; message?: string; details?: unknown; retryable?: boolean; retryAfterMs?: number }) {
    super(opts.message ?? opts.code ?? "gateway error");
    this.code = opts.code;
    this.details = opts.details;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class GatewayClient {
  private opts: Required<
    Pick<GatewayClientOptions, "url" | "clientName" | "clientVersion" | "clientMode" | "instanceId" | "timeoutMs">
  > &
    Pick<GatewayClientOptions, "token" | "password" | "debug" | "store">;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedPromise: Promise<HelloOkPayload> | null = null;
  private connectNonce: string | null = null;
  private nonceWaiters: Array<(nonce: string) => void> = [];
  private device: DeviceIdentity | null = null;
  private gatewayId: string;
  private lastHello: HelloOkPayload | null = null;
  private pairingPending: PairingPending | null = null;
  private lastSuccessAtMs: number | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = {
      url: opts.url,
      token: opts.token,
      password: opts.password,
      clientName: opts.clientName ?? "openclaw-claw-mcp",
      clientVersion: opts.clientVersion ?? "0.1.0",
      clientMode: opts.clientMode ?? "ui",
      instanceId: opts.instanceId ?? `openclaw-claw-mcp-${process.pid}`,
      timeoutMs: opts.timeoutMs ?? 30_000,
      store: opts.store,
      debug: opts.debug,
    };
    this.gatewayId = Store.gatewayId(opts.url);
  }

  private log(msg: string) {
    this.opts.debug?.(`[gateway] ${msg}`);
  }

  getDevice(): DeviceIdentity | null {
    return this.device;
  }

  getLastHello(): HelloOkPayload | null {
    return this.lastHello;
  }

  getGatewayId(): string {
    return this.gatewayId;
  }

  getPairingPending(): PairingPending | null {
    return this.pairingPending;
  }

  async connect(): Promise<HelloOkPayload> {
    if (this.connectedPromise) return this.connectedPromise;
    this.connectedPromise = this.doConnect();
    try {
      return await this.connectedPromise;
    } catch (err) {
      this.connectedPromise = null;
      throw err;
    }
  }

  private async loadOrCreateDevice(): Promise<DeviceIdentity> {
    if (this.device) return this.device;
    const store = this.opts.store;
    if (store) {
      const existing = await store.loadDevice();
      if (existing) {
        const verified = await verifyDeviceId(existing);
        if (verified.deviceId !== existing.deviceId) {
          await store.saveDevice({ ...verified, createdAtMs: existing.createdAtMs });
        }
        this.device = { deviceId: verified.deviceId, publicKey: verified.publicKey, privateKey: verified.privateKey };
        this.log(`loaded device identity ${this.device.deviceId.slice(0, 16)}…`);
        return this.device;
      }
      const created = await generateDevice();
      await store.saveDevice({ ...created, createdAtMs: Date.now() });
      this.device = created;
      this.log(`generated new device identity ${created.deviceId.slice(0, 16)}… (persisted)`);
      return this.device;
    }
    const ephemeral = await generateDevice();
    this.device = ephemeral;
    this.log(`generated ephemeral device identity ${ephemeral.deviceId.slice(0, 16)}…`);
    return this.device;
  }

  private async loadDeviceToken(): Promise<DeviceTokenEntry | undefined> {
    if (!this.opts.store) return undefined;
    return this.opts.store.loadToken(this.gatewayId);
  }

  private async waitForNonce(maxWaitMs = 1500): Promise<string> {
    if (this.connectNonce) return this.connectNonce;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.nonceWaiters = this.nonceWaiters.filter((w) => w !== onNonce);
        resolve(this.connectNonce ?? "");
      }, maxWaitMs);
      const onNonce = (nonce: string) => {
        clearTimeout(timer);
        resolve(nonce);
      };
      this.nonceWaiters.push(onNonce);
    });
  }

  private async doConnect(): Promise<HelloOkPayload> {
    await this.waitOpen();

    const device = await this.loadOrCreateDevice();
    const tokenEntry = await this.loadDeviceToken();

    const role = "operator";
    const scopes = tokenEntry?.scopes?.length ? tokenEntry.scopes : DEFAULT_SCOPES;
    const signedAtMs = Date.now();
    const nonce = await this.waitForNonce();
    if (!nonce) {
      throw new Error("gateway did not deliver connect.challenge nonce within 1500ms");
    }
    const signature = await signConnect(
      {
        deviceId: device.deviceId,
        clientId: CLIENT_ID,
        clientMode: this.opts.clientMode,
        role,
        scopes,
        signedAtMs,
        token: this.opts.token ?? null,
        nonce,
      },
      device.privateKey,
    );

    const auth: { token?: string; password?: string; deviceToken?: string } = {};
    if (this.opts.token) auth.token = this.opts.token;
    if (this.opts.password) auth.password = this.opts.password;
    if (tokenEntry?.token) auth.deviceToken = tokenEntry.token;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CLIENT_ID,
        displayName: this.opts.clientName,
        version: this.opts.clientVersion,
        platform: process.platform,
        mode: this.opts.clientMode,
        instanceId: this.opts.instanceId,
      },
      locale: "en-US",
      userAgent: this.opts.clientName,
      role,
      scopes,
      caps: [] as string[],
      auth,
      device: {
        id: device.deviceId,
        publicKey: device.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };

    this.log(`sending connect (deviceId=${device.deviceId.slice(0, 16)}…, deviceToken=${tokenEntry ? "yes" : "no"}, nonce=${nonce ? "yes" : "no"})`);
    let payload: HelloOkPayload;
    try {
      payload = (await this.requestRaw("connect", params)) as HelloOkPayload;
    } catch (err) {
      if (err instanceof GatewayError) {
        const details = err.details as { code?: string; requestId?: string; reason?: string } | undefined;
        if (details?.code === "PAIRING_REQUIRED" && details.requestId) {
          this.pairingPending = {
            requestId: details.requestId,
            reason: details.reason,
            detectedAtMs: Date.now(),
          };
          this.log(`pairing required: requestId=${details.requestId}`);
        }
      }
      throw err;
    }
    this.pairingPending = null;
    this.log(`connect ok (server=${payload.server?.version ?? "?"})`);
    this.lastHello = payload;

    if (this.opts.store && payload.auth?.deviceToken) {
      const entry: DeviceTokenEntry = {
        token: payload.auth.deviceToken,
        role: payload.auth.role ?? role,
        scopes: payload.auth.scopes ?? [],
        savedAtMs: Date.now(),
      };
      await this.opts.store.saveToken(this.gatewayId, entry);
      this.log(`device token persisted (scopes=${entry.scopes.join(",") || "<none>"})`);
    }

    return payload;
  }

  private waitOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.log(`opening WebSocket to ${this.opts.url}`);
      const ws = new WebSocket(this.opts.url, { handshakeTimeout: this.opts.timeoutMs });
      this.ws = ws;

      const timer = setTimeout(() => {
        reject(new Error(`ws open timeout after ${this.opts.timeoutMs}ms`));
        ws.close();
      }, this.opts.timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        this.log(`socket open`);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        this.log(`socket error: ${err.message}`);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
      ws.on("close", (code, reason) => {
        this.log(`socket closed: ${code} ${reason.toString()}`);
        this.flushPending(new Error(`gateway closed (${code}): ${reason.toString()}`));
        this.ws = null;
        this.connectedPromise = null;
      });
    });
  }

  private sendRaw(frame: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const payload = JSON.stringify(frame);
    this.log(`> (${payload.length} bytes) ${payload.length > 600 ? payload.slice(0, 600) + "..." : payload}`);
    this.ws.send(payload);
  }

  private handleMessage(raw: string) {
    this.log(`< (${raw.length} bytes) ${raw.length > 8000 ? raw.slice(0, 8000) + "..." : raw}`);
    let frame: ResFrame | EventFrame | { type: string; [k: string]: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      this.log(`failed to parse frame`);
      return;
    }

    if (frame.type === "event") {
      const ev = frame as EventFrame;
      if (ev.event === "connect.challenge") {
        const nonce = ev.payload?.nonce;
        if (typeof nonce === "string") {
          this.connectNonce = nonce;
          this.log(`stored connect nonce`);
          const waiters = this.nonceWaiters;
          this.nonceWaiters = [];
          for (const w of waiters) w(nonce);
        }
      }
      return;
    }

    if (frame.type === "res") {
      const res = frame as ResFrame;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) {
        p.resolve(res.payload);
      } else {
        const err =
          typeof res.error === "object" && res.error !== null
            ? (res.error as { code?: string; message?: string; details?: unknown; retryable?: boolean; retryAfterMs?: number })
            : { message: String(res.error ?? "request failed") };
        p.reject(new GatewayError(err));
      }
      return;
    }

    this.log(`unknown frame type: ${frame.type}`);
  }

  private flushPending(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private requestRaw<T = unknown>(method: string, params: unknown = undefined): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = randomUUID();
    const frame: ReqFrame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request '${method}' timed out after ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        this.sendRaw(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async request<T = unknown>(method: string, params: unknown = undefined): Promise<T> {
    const maxAttempts = 4; // 1 initial + 3 retries (1s, 2s, 4s)
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.connect();
        const result = await this.requestRaw<T>(method, params);
        this.lastSuccessAtMs = Date.now();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxAttempts || !isTransientError(lastError)) throw lastError;
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 60_000);
        this.log(`request '${method}' attempt ${attempt}/${maxAttempts} failed (${lastError.message}); retrying in ${delayMs}ms`);
        // Reset connection state so the next attempt re-handshakes from a clean slate
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        this.connectedPromise = null;
        this.connectNonce = null;
        this.flushPending(lastError);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError ?? new Error(`request '${method}' failed after ${maxAttempts} attempts`);
  }

  getLastSuccessAtMs(): number | null {
    return this.lastSuccessAtMs;
  }

  async close(): Promise<void> {
    this.flushPending(new Error("client closing"));
    this.ws?.close();
    this.ws = null;
  }
}

export function isTransientError(err: Error): boolean {
  if (err instanceof GatewayError) {
    if (err.retryable === true) return true;
    // Server-side hints we should not retry: scope/auth/validation errors are user-fixable.
    const code = err.code ?? "";
    if (/INVALID|FORBIDDEN|MISSING|NOT_FOUND|PAIRING|UNAUTHENTICATED|CONFLICT/i.test(code)) return false;
    return false;
  }
  // WebSocket / network / timeout / DNS errors are transient.
  return /not connected|timed out|ws open timeout|gateway closed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
    err.message,
  );
}
