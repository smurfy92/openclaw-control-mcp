import type { CallOpts, ToolClient } from "../../src/tools/client.js";

type MockCall = {
  method: string;
  params: unknown;
  opts?: CallOpts;
};

type MockClientHandle = {
  client: ToolClient;
  calls: MockCall[];
  setNextResponse(value: unknown): void;
  /**
   * Replace the request handler entirely for tests that need stateful behaviour
   * (e.g. config.get → config.patch flow that reuses the in-memory state).
   */
  setRequestHandler(
    fn: (call: MockCall) => Promise<unknown> | unknown,
  ): void;
};

/**
 * Shared test stub for `ToolClient`. Used in unit tests that exercise tool
 * builders without touching the real GatewayClient. Keeps every dispatched
 * call so assertions can inspect `(method, params, opts)` after the fact.
 *
 * Default response is `{ ok: true }`; override per test via setNextResponse
 * (one-shot) or setRequestHandler (full custom behaviour).
 */
export function makeMockClient(): MockClientHandle {
  const calls: MockCall[] = [];
  let nextResponse: unknown = { ok: true };
  let handler: ((call: MockCall) => Promise<unknown> | unknown) | null = null;

  const client: ToolClient = {
    async request(method, params, opts) {
      const call: MockCall = { method, params, opts };
      calls.push(call);
      if (handler) {
        const r = await handler(call);
        return r as never;
      }
      return nextResponse as never;
    },
    async connect() {},
    async close() {},
    getDevice: () => null,
    getLastHello: () => null,
    getPairingPending: () => null,
    getGatewayId: () => "mock",
    getLastSuccessAtMs: () => null,
  };

  return {
    client,
    calls,
    setNextResponse(value) {
      nextResponse = value;
    },
    setRequestHandler(fn) {
      handler = fn;
    },
  };
}
