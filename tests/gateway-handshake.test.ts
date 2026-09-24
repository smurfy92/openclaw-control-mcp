import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { GatewayClient } from "../src/gateway/client.js";
import { buildSigningString, fromBase64Url } from "../src/gateway/device.js";
import { Store } from "../src/gateway/store.js";
import { NO_REPLY, startFakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";

// Env vars that would short-circuit the store-based device/token flow.
const ENV_KEYS = [
  "OPENCLAW_DEVICE_PRIVATE_KEY",
  "OPENCLAW_DEVICE_TOKEN",
  "OPENCLAW_RETRY_ATTEMPTS",
  "OPENCLAW_RETRY_BASE_MS",
] as const;

let dir: string;
let store: Store;
let gw: FakeGateway;
let client: GatewayClient | null = null;
const savedEnv = new Map<string, string | undefined>();
const uncaught: Error[] = [];

function onUncaught(err: Error) {
  uncaught.push(err);
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  // Never touch the real store: everything lives in a throwaway temp dir.
  dir = mkdtempSync(join(tmpdir(), "openclaw-handshake-"));
  store = new Store(dir, "store.json");
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
});

afterEach(async () => {
  process.off("uncaughtException", onUncaught);
  await client?.close().catch(() => {});
  client = null;
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GatewayClient handshake against a fake gateway", () => {
  it("completes the signed handshake and persists the device token", async () => {
    gw = await startFakeGateway({ deviceToken: "DEV-TOKEN-XYZ", nonce: "nonce-1" });
    client = new GatewayClient({
      url: gw.url,
      store,
      timeoutMs: 5000,
      clientName: "openclaw-control-mcp",
      clientVersion: "9.9.9-test",
    });

    const hello = await client.connect();
    expect(hello.server?.version).toBe("9.9.9-fake");

    const params = gw.lastConnectParams() as {
      client: { displayName: string; version: string; id: string };
      role: string;
      scopes: string[];
      device: { id: string; publicKey: string; signature: string; signedAt: number; nonce: string };
    };
    // Identity actually put on the wire (the regression fixed in src/index.ts).
    expect(params.client.displayName).toBe("openclaw-control-mcp");
    expect(params.client.version).toBe("9.9.9-test");
    expect(params.device.nonce).toBe("nonce-1");

    // The signature must verify against the device public key — i.e. the device
    // identity is the Ed25519 key, not the display name.
    const message = new TextEncoder().encode(
      buildSigningString({
        deviceId: params.device.id,
        clientId: params.client.id,
        clientMode: "ui",
        role: params.role,
        scopes: params.scopes,
        signedAtMs: params.device.signedAt,
        token: null,
        nonce: "nonce-1",
      }),
    );
    const ok = await ed.verifyAsync(
      fromBase64Url(params.device.signature),
      message,
      fromBase64Url(params.device.publicKey),
    );
    expect(ok).toBe(true);

    // Device token persisted for the next run, keyed by gatewayId.
    const onDisk = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as {
      tokens: Record<string, { token: string }>;
      device: { privateKey: string };
    };
    expect(onDisk.device.privateKey).toBeTruthy();
    expect(Object.values(onDisk.tokens)[0]?.token).toBe("DEV-TOKEN-XYZ");
  });

  it("survives a socket error after open, rejects pending requests, and does not crash the process", async () => {
    process.env.OPENCLAW_RETRY_ATTEMPTS = "1"; // surface the failure instead of retrying
    gw = await startFakeGateway({ onRequest: () => NO_REPLY });
    client = new GatewayClient({ url: gw.url, store, timeoutMs: 5000 });

    const pending = client.request("status.get");
    await gw.waitForConnections(1);
    // Wait until the hanging request has actually been dispatched.
    await new Promise((r) => setTimeout(r, 100));
    gw.resetActiveSocket(); // ECONNRESET on an already-open socket

    await expect(pending).rejects.toThrow(/status\.get/);
    // No `error` event reached the process as an uncaught exception.
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
  });

  it("re-handshakes on the next call after the socket died", async () => {
    gw = await startFakeGateway({ onRequest: () => ({ pong: true }) });
    client = new GatewayClient({ url: gw.url, store, timeoutMs: 5000 });

    await client.request("status.get");
    expect(gw.connectionCount()).toBe(1);

    gw.resetActiveSocket();
    await new Promise((r) => setTimeout(r, 100));

    const again = await client.request<{ pong: boolean }>("status.get");
    expect(again.pong).toBe(true);
    expect(gw.connectionCount()).toBe(2);
    // Second handshake replays the full connect frame, with the token it stored.
    expect(gw.requests.filter((r) => r.method === "connect").length).toBe(2);
  });

  it("retries transiently and succeeds once the gateway answers again", async () => {
    process.env.OPENCLAW_RETRY_ATTEMPTS = "3";
    process.env.OPENCLAW_RETRY_BASE_MS = "100";
    let first = true;
    gw = await startFakeGateway({
      onRequest: (_frame, socket) => {
        if (first) {
          first = false;
          socket.terminate(); // socket dies mid-request → transient failure
          return NO_REPLY;
        }
        return { pong: true };
      },
    });
    client = new GatewayClient({ url: gw.url, store, timeoutMs: 5000 });

    const res = await client.request<{ pong: boolean }>("status.get");
    expect(res.pong).toBe(true);
    expect(gw.connectionCount()).toBeGreaterThanOrEqual(2);
  });
});
