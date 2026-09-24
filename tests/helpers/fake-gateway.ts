import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

export type ReqFrame = { type: "req"; id: string; method: string; params?: unknown };

export type FakeGatewayOptions = {
  /** Nonce delivered in the `connect.challenge` event. */
  nonce?: string;
  /** Device token handed back in the `connect` response (omit for none). */
  deviceToken?: string;
  /** Set to false to never emit `connect.challenge` (tests the 1500 ms timeout). */
  sendChallenge?: boolean;
  /**
   * Responder for non-`connect` methods. Return a value to answer `ok`, throw a
   * `{ code, message }` to answer with an error frame, or return the sentinel
   * `NO_REPLY` to leave the request hanging (used to test pending-request flush).
   */
  onRequest?: (frame: ReqFrame, socket: ServerSocket) => unknown;
};

/** Sentinel: the fake gateway swallows the request and never answers. */
export const NO_REPLY = Symbol("no-reply");

export type FakeGateway = {
  url: string;
  /** Number of accepted WebSocket connections since start. */
  connectionCount: () => number;
  /** Every `req` frame received, in order, across all connections. */
  requests: ReqFrame[];
  /** Params of the last `connect` request. */
  lastConnectParams: () => Record<string, unknown> | null;
  /** Wait until at least `n` connections have been accepted. */
  waitForConnections: (n: number, timeoutMs?: number) => Promise<void>;
  /** Abruptly RST the live socket → the client sees an `ECONNRESET` error event. */
  resetActiveSocket: () => void;
  /** Clean close of the live socket with a code. */
  closeActiveSocket: (code?: number, reason?: string) => void;
  setOnRequest: (fn: FakeGatewayOptions["onRequest"]) => void;
  stop: () => Promise<void>;
};

/**
 * Minimal in-process stand-in for an OpenClaw gateway: a `ws` server bound to
 * 127.0.0.1 on an ephemeral port that speaks the same three frame types as the
 * real management plane (`event` / `req` / `res`), emits `connect.challenge`
 * on connection and answers `connect` with a `hello-ok`-shaped payload.
 *
 * It never talks to anything outside the test process and holds no state on
 * disk. Used to exercise the handshake, the socket-error path and the
 * reconnection loop of `GatewayClient` without a real gateway.
 */
export async function startFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const nonce = opts.nonce ?? "nonce-abc123";
  const sendChallenge = opts.sendChallenge !== false;
  let onRequest = opts.onRequest;

  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const requests: ReqFrame[] = [];
  let connections = 0;
  let connectParams: Record<string, unknown> | null = null;
  let active: ServerSocket | null = null;
  const connectionWaiters: Array<() => void> = [];

  wss.on("connection", (socket) => {
    connections += 1;
    active = socket;
    for (const w of connectionWaiters.splice(0)) w();
    socket.on("error", () => {
      /* client-side resets surface here too — ignore, the test asserts on the client */
    });

    if (sendChallenge) {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce } }));
    }

    socket.on("message", (data) => {
      let frame: ReqFrame;
      try {
        frame = JSON.parse(data.toString("utf8")) as ReqFrame;
      } catch {
        return;
      }
      if (frame.type !== "req") return;
      requests.push(frame);

      if (frame.method === "connect") {
        connectParams = (frame.params ?? {}) as Record<string, unknown>;
        const auth: Record<string, unknown> = { role: "operator", scopes: ["operator.read"] };
        if (opts.deviceToken) auth.deviceToken = opts.deviceToken;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "9.9.9-fake", connId: "conn-1" },
              features: { methods: ["connect", "status.get"], events: ["connect.challenge"] },
              auth,
            },
          }),
        );
        return;
      }

      if (!onRequest) {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
        return;
      }
      try {
        const result = onRequest(frame, socket);
        if (result === NO_REPLY) return;
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: result }));
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: unknown };
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: e.code, message: e.message, details: e.details },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    connectionCount: () => connections,
    requests,
    lastConnectParams: () => connectParams,
    waitForConnections: (n, timeoutMs = 2000) =>
      new Promise<void>((resolve, reject) => {
        if (connections >= n) return resolve();
        const timer = setTimeout(() => reject(new Error(`only ${connections}/${n} connections after ${timeoutMs}ms`)), timeoutMs);
        const check = () => {
          if (connections >= n) {
            clearTimeout(timer);
            resolve();
          } else {
            connectionWaiters.push(check);
          }
        };
        connectionWaiters.push(check);
      }),
    resetActiveSocket: () => {
      // `resetAndDestroy` sends a TCP RST, which the client's socket reports as
      // ECONNRESET — i.e. an `error` event emitted *after* the socket is open.
      const raw = (active as unknown as { _socket?: { resetAndDestroy?: () => void; destroy: () => void } })?._socket;
      if (!raw) return;
      if (typeof raw.resetAndDestroy === "function") raw.resetAndDestroy();
      else raw.destroy();
    },
    closeActiveSocket: (code = 1001, reason = "going away") => {
      active?.close(code, reason);
    },
    setOnRequest: (fn) => {
      onRequest = fn;
    },
    stop: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
