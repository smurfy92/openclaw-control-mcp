// Probe what schema introspection the gateway exposes (for auto-gen Zod design).
import { GatewayClient } from "../src/gateway/client.js";
import { Store } from "../src/gateway/store.js";

async function main() {
  const store = new Store();
  const cfg = await store.loadConfig();
  if (!cfg.gatewayUrl) {
    process.stdout.write("no default gateway configured\n");
    process.exit(1);
  }
  const c = new GatewayClient({
    url: cfg.gatewayUrl,
    token: cfg.gatewayToken,
    password: cfg.gatewayPassword,
    store,
  });
  await c.connect();

  const hello = c.getLastHello();
  const methods = (hello?.features?.methods ?? []) as string[];
  process.stdout.write(`hello.features.methods count: ${methods.length}\n`);
  process.stdout.write(`first 10: ${JSON.stringify(methods.slice(0, 10))}\n`);
  process.stdout.write(
    `schema-related: ${JSON.stringify(methods.filter((m) => /schema|introspect|discover/i.test(m)))}\n`,
  );

  async function call(method: string, params: unknown = {}) {
    try {
      const r = await c.request(method, params);
      return { ok: true, result: r };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  process.stdout.write("\n== config.schema ==\n");
  const cs = await call("config.schema");
  if (cs.ok && cs.result && typeof cs.result === "object") {
    const r = cs.result as Record<string, unknown>;
    process.stdout.write(`top keys: ${JSON.stringify(Object.keys(r))}\n`);
    const j = JSON.stringify(r);
    process.stdout.write(`size: ${j.length} chars\n`);
    process.stdout.write(`first 800 chars: ${j.slice(0, 800)}\n`);
  } else {
    process.stdout.write(`fail: ${(cs as any).error?.slice(0, 200)}\n`);
  }

  process.stdout.write("\n== RPC introspection probes ==\n");
  const probes = [
    "rpc.schema",
    "rpc.list",
    "rpc.methods",
    "rpc.discover",
    "methods.list",
    "methods.schema",
    "schema.list",
    "schema.method",
    "introspect",
    "gateway.methods",
    "gateway.schema",
    "gateway.rpc.list",
  ];
  for (const m of probes) {
    const r = await call(m, { method: "cron.add" });
    if (r.ok) {
      process.stdout.write(
        `ok ${m} -> ${JSON.stringify(r.result).slice(0, 300)}\n`,
      );
    } else {
      process.stdout.write(`no ${m} -- ${(r as any).error?.slice(0, 120)}\n`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}\n`);
  process.exit(2);
});
