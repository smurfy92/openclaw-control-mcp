// Probe what params `agent` (root method) actually wants from the gateway.
import { GatewayClient } from "../src/gateway/client.js";
import { Store } from "../src/gateway/store.js";

async function main() {
  const store = new Store();
  const cfg = await store.loadConfig();
  if (!cfg.gatewayUrl) process.exit(1);
  const c = new GatewayClient({
    url: cfg.gatewayUrl,
    token: cfg.gatewayToken,
    password: cfg.gatewayPassword,
    store,
  });
  await c.connect();

  for (const args of [
    {},
    { message: "test" },
    { message: "test", agentId: "main" },
    { message: "test", agentId: "main", sessionId: "agent:main:main" },
  ] as Array<Record<string, unknown>>) {
    try {
      const r = await c.request("agent", args);
      process.stdout.write(`agent ${JSON.stringify(args)} → OK ${JSON.stringify(r).slice(0, 200)}\n`);
    } catch (err) {
      process.stdout.write(`agent ${JSON.stringify(args)} → ${(err as Error).message.slice(0, 300)}\n`);
    }
  }
  process.stdout.write("\n--- send (root method) ---\n");
  for (const args of [
    {},
    { text: "ping" },
    { text: "ping", idempotencyKey: "k1" },
  ] as Array<Record<string, unknown>>) {
    try {
      const r = await c.request("send", args);
      process.stdout.write(`send ${JSON.stringify(args)} → OK ${JSON.stringify(r).slice(0, 200)}\n`);
    } catch (err) {
      process.stdout.write(`send ${JSON.stringify(args)} → ${(err as Error).message.slice(0, 300)}\n`);
    }
  }

  await c.close();
}

await main();
