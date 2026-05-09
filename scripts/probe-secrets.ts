// Probe what secret-related methods the live gateway exposes.
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
  const hello = c.getLastHello();
  const methods = ((hello?.features?.methods ?? []) as string[]).filter((m) => /secret/i.test(m));
  process.stdout.write(`secret-related methods on live gateway: ${JSON.stringify(methods)}\n`);

  // Probe each candidate
  for (const m of ["secrets.set", "secrets.write", "secrets.create", "secrets.update"]) {
    try {
      await c.request(m, { name: "__probe__", value: "x" });
      process.stdout.write(`${m} → EXISTS (call succeeded)\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`${m} → ${msg.slice(0, 200)}\n`);
    }
  }

  // Also try config.get to see where secrets actually live
  const cg = (await c.request("config.get", {})) as { parsed?: Record<string, unknown> };
  const topKeys = Object.keys(cg.parsed ?? {});
  process.stdout.write(`config top-level keys: ${JSON.stringify(topKeys)}\n`);
  if (cg.parsed && typeof cg.parsed.secrets === "object") {
    process.stdout.write(`config.secrets keys: ${JSON.stringify(Object.keys(cg.parsed.secrets ?? {}))}\n`);
  }

  // Try secrets.resolve on a known config-tree path
  for (const ref of [
    "channels.telegram.botToken",
    "secrets.TEST",
    "${secrets.TEST}",
    "TEST",
    "channels.discord.token",
  ]) {
    try {
      const r = await c.request("secrets.resolve", { name: ref });
      process.stdout.write(`secrets.resolve(${ref}) → ${JSON.stringify(r).slice(0, 200)}\n`);
    } catch (err) {
      process.stdout.write(`secrets.resolve(${ref}) → FAIL: ${(err as Error).message.slice(0, 150)}\n`);
    }
  }

  await c.close();
}

await main();
