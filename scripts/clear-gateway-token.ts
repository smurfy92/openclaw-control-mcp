// Drop the gateway admin token from the store while keeping the password and
// the URL. When `gatewayToken` is unset, the WebSocket handshake falls back to
// password-only auth — which is the recovery path when the admin token got
// rotated server-side and you don't have the new value yet, but the password
// has not been rotated.
//
// Usage:
//   npx tsx scripts/clear-gateway-token.ts                # default instance
//   npx tsx scripts/clear-gateway-token.ts --instance default
//   npx tsx scripts/clear-gateway-token.ts --dry-run      # show what would change

import { Store } from "../src/gateway/store.js";

async function main() {
  const args = process.argv.slice(2);
  const instIdx = args.indexOf("--instance");
  const instance = instIdx >= 0 ? (args[instIdx + 1] ?? "default") : "default";
  const dryRun = args.includes("--dry-run");

  const store = new Store();
  const cfg = await store.loadConfig(instance);
  if (!cfg.gatewayUrl) {
    process.stderr.write(`instance '${instance}' not configured\n`);
    process.exit(1);
  }

  const hasToken = !!cfg.gatewayToken;
  const hasPassword = !!cfg.gatewayPassword;
  process.stdout.write(
    `before: hasToken=${hasToken}, hasPassword=${hasPassword}, gatewayUrl=${cfg.gatewayUrl}\n`,
  );
  if (!hasToken) {
    process.stdout.write("nothing to clear — no token persisted.\n");
    return;
  }
  if (!hasPassword) {
    process.stderr.write(
      "refusing: clearing the token without a password would leave no admin auth at all.\n" +
        "  set --instance to another instance, or re-add a password first.\n",
    );
    process.exit(2);
  }

  if (dryRun) {
    process.stdout.write("--dry-run: would clear gatewayToken (password kept).\n");
    return;
  }

  await store.saveConfig({ gatewayToken: undefined }, instance);
  const after = await store.loadConfig(instance);
  process.stdout.write(
    `after:  hasToken=${!!after.gatewayToken}, hasPassword=${!!after.gatewayPassword}\n`,
  );
  process.stdout.write("done — next connect will use password-only auth.\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}\n`);
  process.exit(2);
});
