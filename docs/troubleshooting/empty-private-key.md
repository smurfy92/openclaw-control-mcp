# Empty `device.privateKey` after pairing — `expected Uint8Array of length 32, got length=0`

**Reported:** 2026-05-05 against `openclaw-control-mcp@0.4.3`, gateway `2026.4.12`.

**Status (2026-07-28, 0.8.0):** this failure mode is **structurally gone**. ADR-006 removed the OS keychain entirely — `stripSecretsToKeychain` and `hydrateSecretsFromKeychain` no longer exist, and secrets are written straight into `store.json` (mode 0600), so there is no longer a path where the in-memory copy is blanked after a write that silently no-op'd. Everything below is kept as the historical analysis.

If you hit the empty-`privateKey` symptom *after upgrading to 0.8.0*, the cause is different: your key is still in the OS keychain from 0.5.0–0.7.0. Run `npx -y openclaw-control-mcp --migrate-from-keychain` once to import it, or `openclaw_device_repair` to wipe and re-pair.

---

**Status (2026-05-10, 0.6.1):** the three fixes proposed below are **all shipped** — `safeSet` (fix #1) since 0.5.0, `DevicePrivateKeyMissingError` (fix #3) since 0.5.0, self-heal via `repairDevice` (fix #2) since 0.5.0. Since 0.6.1 every secret is bundled into a single keychain item (see [ADR-001 § Evolution](../adr/001-multi-instance-store-with-keychain-backed-secrets.md)) — the bundle write is gated by the same `safeSet`, so the empty-private-key class of bug is contained at the same level. The recovery procedure below remains valid if you ever wipe the keychain manually (e.g. `security delete-generic-password ...`) and the store still references the now-orphaned device.

## Symptoms

Every gateway-touching MCP tool (`openclaw_health`, `openclaw_status`, `openclaw_device_status`, `openclaw_introspect`, …) fails with:

```
gateway request 'health' failed (attempt 1/4): expected Uint8Array of length 32, got length=0
```

`openclaw_device_status` reports:

```json
{
  "device": { "deviceId": "…", "publicKeyFingerprint": "…" },
  "paired": false,
  "pendingPairing": null,
  "scopes": [],
  "role": null,
  "server": null,
  "nextStep": "Connect attempt failed: expected Uint8Array of length 32, got length=0"
}
```

Note that `pendingPairing` is **`null`** (not the usual `{ requestId, reason: "not-paired" }`) — the connect frame never even reaches the gateway because signing fails locally first.

## Root cause

`@noble/ed25519`'s `signAsync(message, sk)` requires `sk.length === 32`. The MCP client passes `fromBase64Url(state.device.privateKey)` as `sk` — when `state.device.privateKey === ""` you get a 0-byte buffer and the signer throws.

The empty `privateKey` comes from `Store.stripSecretsToKeychain` (`src/gateway/store.ts:150-177`):

```ts
if (cleaned.device?.privateKey) {
  await kc.set("device-private-key", cleaned.device.privateKey);
  cleaned.device = { ...cleaned.device, privateKey: "" };  // ← always blanks
}
```

The code blanks the field **regardless of whether `kc.set` actually persisted the value**. At load time, `hydrateSecretsFromKeychain` (`store.ts:185-189`) re-reads it from the keychain — but if the keychain has nothing under `device-private-key`, the in-memory state stays with `privateKey: ""`.

This bites in at least three scenarios:

1. **The MCP fell back to `NoopBackend`** (no `security` CLI on macOS, no `secret-tool` on Linux). `NoopBackend.set` is a no-op, so the clean-up loop discards the only copy of the key.
2. **The keychain entry was wiped externally**: macOS keychain reset after an OS upgrade, libsecret password change, or the user manually deleted the entry.
3. **A migration path mutated `store.json` without keeping the keychain in sync** (e.g. v1→v2 migration on a host where `resolveKeychainBackend()` resolved differently across runs).

The store ends up persistently inconsistent — `device.publicKey` survives (it's not a secret) but `device.privateKey` is empty. Every subsequent tool call hits the `length=0` crash.

## What store.json looks like when broken

```json
{
  "version": 2,
  "device": {
    "deviceId": "a27f5e190ffd2ddd0a593473c3948629dc1cff242e926ab94bc0bb57beb78a92",
    "publicKey": "ZgjZnLDK2aK86AoTqHj8F18XRVzZOxfzsv-fba0mD_A",
    "privateKey": "",                                               // ← the bug
    "createdAtMs": 1777306090434
  },
  "tokens": {
    "6cfc673763ef16c0": { "token": "", "role": "operator", … }
  },
  "configs": { … }
}
```

## Workaround (user-side)

Wipe `device` and `tokens` from the store and let the MCP regenerate a fresh keypair on the next call:

```bash
# 1. Backup
cp ~/.config/openclaw-control-mcp/store.json \
   ~/.config/openclaw-control-mcp/store.json.bak.$(date +%s)

# 2. Wipe device + tokens (keep configs.gatewayUrl/Token)
python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.config/openclaw-control-mcp/store.json'
s = json.loads(p.read_text())
s.pop('device', None)
s['tokens'] = {}
p.write_text(json.dumps(s, indent=2))
"

# 3. Restart Claude Code (or whatever MCP client) so the daemon re-reads the store
# 4. Call openclaw_device_status — generates a fresh Ed25519 keypair, surfaces a new pendingPairing.requestId
# 5. Approve the request in Control panel → Devices (the NEW fingerprint, not the orphaned old one)
# 6. Re-call openclaw_setup with the same gatewayUrl + gatewayToken — this forces a fresh WS handshake
#    (a single openclaw_device_status after approval was not enough in our repro;
#     we needed openclaw_setup → openclaw_device_status to trigger a clean reconnect)
# 7. openclaw_device_status now returns paired: true with the operator scopes
```

The orphaned approved device on the gateway side (the one whose privateKey was lost) is harmless — its token never gets used — but you may want to revoke it from the Control panel for cleanliness.

## Suggestions for a permanent fix

The bug is hard to detect from the gateway side (it sees no incoming connect frame at all), so the recovery has to live in the client. In rough order of impact:

### 1. **Validate `privateKey` before stripping** (`store.ts:150-177`)

Don't blank the field if `kc.set` returned without actually writing. Concretely:

```ts
if (cleaned.device?.privateKey) {
  const ok = await safeKeychainSet(kc, "device-private-key", cleaned.device.privateKey);
  if (ok) {
    cleaned.device = { ...cleaned.device, privateKey: "" };
  }
  // else: keep the privateKey in store.json (less safe but functional)
}
```

`NoopBackend.set` would return `false`, MacOS/libsecret backends would return `true` only when the underlying CLI exits 0. Trade-off: the privateKey lives in `store.json` (mode 0600) when no real keychain is available — that's fine for a dev box, and matches the documented v1 design before keychain integration was added.

### 2. **Self-heal at load** (`store.ts:185-189`)

If after `hydrateSecretsFromKeychain` we have a `device.publicKey` but still no `device.privateKey`, the device is unrecoverable. Detect this and either:

- **Auto-regenerate**: drop the broken device, generate a new keypair, force a re-pair. Document the behavior so users know an old approval needs to be revoked.
- **Hard-fail with a clear message**: throw `DevicePrivateKeyMissingError` with the workaround steps in the message. Wire this through to `openclaw_device_status.nextStep` so the user gets actionable guidance instead of `Uint8Array of length 32, got length=0`.

### 3. **Pre-sign assertion** (`device.ts:62-65`)

```ts
export async function signConnect(input: SignConnectInput, privateKey: string): Promise<string> {
  const sk = fromBase64Url(privateKey);
  if (sk.length !== 32) {
    throw new Error(
      `device private key is empty or malformed (got ${sk.length} bytes, expected 32). ` +
      `Wipe ~/.config/openclaw-control-mcp/store.json device + tokens and restart the MCP. ` +
      `See docs/troubleshooting/empty-private-key.md.`
    );
  }
  const sig = await ed.signAsync(message, sk);
  …
}
```

Cheap to add, immediately turns the cryptic noble error into something the user can act on.

### 4. **`openclaw_device_repair` tool**

Single-purpose tool that:

1. Detects the inconsistency (`publicKey` set, `privateKey` absent from both store and keychain)
2. Backs up the current `store.json` to `store.json.bak.<ts>`
3. Wipes the broken device and cached tokens
4. Re-runs the connect handshake (pairing reset)

Saves users from copy-pasting the python one-liner above.

## Repro & verification (for the fix PR)

The bug is keychain-dependent so a hermetic test should:

1. Build a `Store` with an injected `KeychainBackend` whose `set` is a stub that resolves `undefined` but never actually writes (= NoopBackend behaviour, but addressable from a test).
2. Save state with `device.privateKey = "AAAA…"`.
3. Re-load. Assert `state.device.privateKey === ""`.
4. After applying fix #1: assert that the privateKey is preserved in `store.json`.
5. After applying fix #3: call `signConnect({…}, "")` and assert it throws the new message, not the noble crash.
