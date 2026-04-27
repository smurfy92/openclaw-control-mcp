import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientVersion?: string;
  clientMode?: string;
  instanceId?: string;
  timeoutMs?: number;
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
type EventFrame = { type: "event"; event: string; payload?: unknown; seq?: number };

const DEFAULT_SCOPES = ["operator.read", "operator.write", "operator.admin"];

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
    Pick<GatewayClientOptions, "token" | "password" | "debug">;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedPromise: Promise<void> | null = null;

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
      debug: opts.debug,
    };
  }

  private log(msg: string) {
    this.opts.debug?.(`[gateway] ${msg}`);
  }

  async connect(): Promise<void> {
    if (this.connectedPromise) return this.connectedPromise;
    this.connectedPromise = this.doConnect();
    try {
      await this.connectedPromise;
    } catch (err) {
      this.connectedPromise = null;
      throw err;
    }
  }

  private async doConnect(): Promise<void> {
    await this.waitOpen();
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-ios",
        displayName: this.opts.clientName,
        version: this.opts.clientVersion,
        platform: "dev",
        mode: this.opts.clientMode,
        instanceId: this.opts.instanceId,
      },
      locale: "en-US",
      userAgent: this.opts.clientName,
      role: "operator",
      scopes: DEFAULT_SCOPES,
      caps: [] as string[],
      auth: this.buildAuth(),
    };
    this.log(`sending connect request`);
    const res = await this.requestRaw("connect", params);
    this.log(`connect ok`);
    return res as void;
  }

  private buildAuth(): { token?: string; password?: string } {
    const auth: { token?: string; password?: string } = {};
    if (this.opts.token) auth.token = this.opts.token;
    if (this.opts.password) auth.password = this.opts.password;
    return auth;
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
    this.log(`> (${payload.length} bytes) ${payload.length > 400 ? payload.slice(0, 400) + "..." : payload}`);
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

    if (frame.type === "event") {
      // ignore connect.challenge and other server events (parity with official smoke client)
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
    await this.connect();
    return this.requestRaw<T>(method, params);
  }

  async close(): Promise<void> {
    this.flushPending(new Error("client closing"));
    this.ws?.close();
    this.ws = null;
  }
}
