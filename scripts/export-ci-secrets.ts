// Read device + token + gateway-token out of the local Store (incl. keychain
// bundle) and print them in a format suitable for piping into `gh secret set`.
//
// Usage:
//   npx tsx scripts/export-ci-secrets.ts                # KEY=value lines on stdout
//   npx tsx scripts/export-ci-secrets.ts --shell        # `export KEY=value` lines (eval-friendly)
//   npx tsx scripts/export-ci-secrets.ts --instance default
//
// The output contains secrets — pipe it, don't tee it into a file you keep.

import { Store } from "../src/gateway/store.js";

async function main() {
  const args = process.argv.slice(2);
  const shell = args.includes("--shell");
  const instIdx = args.indexOf("--instance");
  const instance = instIdx >= 0 ? (args[instIdx + 1] ?? "default") : "default";

  const store = new Store();
  const cfg = await store.loadConfig(instance);
  if (!cfg.gatewayUrl) {
    process.stderr.write(`instance '${instance}' not configured — try --instance <name>\n`);
    process.exit(1);
  }
  const gatewayId = Store.gatewayId(cfg.gatewayUrl);
  const device = await store.loadDevice();
  const tokenEntry = await store.loadToken(gatewayId);

  const out: Record<string, string | undefined> = {
    OPENCLAW_GATEWAY_URL: cfg.gatewayUrl,
    OPENCLAW_GATEWAY_TOKEN: cfg.gatewayToken,
    OPENCLAW_DEVICE_PRIVATE_KEY: device?.privateKey,
    OPENCLAW_DEVICE_TOKEN: tokenEntry?.token,
  };

  const missing = Object.entries(out)
    .filter(([_, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    process.stderr.write(`warning: missing values for ${missing.join(", ")}\n`);
  }

  for (const [k, v] of Object.entries(out)) {
    if (!v) continue;
    const line = shell ? `export ${k}=${shellQuote(v)}` : `${k}=${v}`;
    process.stdout.write(`${line}\n`);
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._:/=+-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}\n`);
  process.exit(2);
});
