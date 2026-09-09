# ADR-001 — Multi-instance Store with keychain-backed secrets

**Status:** Accepted — keychain half **superseded by [ADR-006](006-env-file-secrets-no-keychain.md)** (0.8.0)
**Date:** 2026-05-09

## Context

The MCP needs to talk to one or more OpenClaw gateways. Each gateway has its own URL + login token. Three forces shaped the design:

1. **Multi-tenant operator workflows** — a single Claude Code session may target a personal gateway one minute and a work gateway the next. Forcing the user to flip a global default before each call doesn't scale.
2. **Secrets at rest** — gateway tokens, the per-device Ed25519 private key, and per-gateway issued device tokens must persist across MCP restarts but should not be readable by other processes that drop in `~/.config`.
3. **Migration without disruption** — early adopters started on a v1 single-config `store.json`. A v2 with multiple instances had to import their data losslessly.

## Decision

`src/gateway/store.ts` (the **Store** class) is the single load-bearing persistence layer. It holds:

- A v2 schema with `configs: Record<instanceName, { gatewayUrl, gatewayToken, gatewayPassword? }>` plus a `defaultInstance` pointer.
- Per-gateway-id `tokens` (sha256(url) → DeviceTokenEntry).
- The local Ed25519 device identity.
- A keychain backend resolution layer (`maybeKeychainBackend`) that tries macOS `security`, then Linux `secret-tool`, falling back to plain JSON (mode 0600). Keychain is **on by default** since 0.5.0; opt-out via `OPENCLAW_USE_KEYCHAIN=0`.
- An auto-migration v1 → v2 on first load.

Secrets are split into the keychain on save **only when the keychain `set` actually succeeded** (post-0.5.0 fix in `safeSet` helper). This avoids the failure mode where a no-op or transient backend drops the only copy of the secret.

## Consequences

**Positive**
- Tools can target any instance per-call via the `instance` arg (see ADR-002).
- New gateways are added with `openclaw_setup({ instance: "X", … })` without disturbing existing ones.
- Secrets are protected by the OS keychain when available.

**Negative**
- The Store is an articulation point: every tool that talks to a gateway transitively depends on it. A bug in `load()` or `save()` cascades. Mitigated by tests and the integrity helpers (`deviceIntegrity()`, `repairDevice()`).
- The keychain abstraction has multiple branches (macOS / libsecret / Noop / injected-for-tests). Adding a new backend means updating `resolveKeychainBackend` + the test fixtures.

**Files anchored** — `src/gateway/store.ts` (top of file, marker `// ADR-001`).

## Alternatives considered

- **Single global config** (pre-0.4 design). Forces a `setup` round-trip every time the user wants a different gateway. Rejected — too much friction for the multi-gateway use case.
- **OS keychain only** (no JSON fallback). Breaks on Windows / WSL / hosts without `secret-tool`. Rejected — the legacy plain-JSON path stays so the package works everywhere.

## Evolution — 0.6.1: single keychain item bundle

Pre-0.6.1 the keychain layout used one item per secret: `device-private-key`, `device-token:<gatewayId>`, `gateway-token:<instance>`, `gateway-password:<instance>`. Each item carries its own ACL on macOS, so a fresh process triggered 3-5 separate "Allow keychain access" prompts. `-T /usr/bin/security` did not transitively cover the Node parent process, so the prompt count stayed high even with "Always Allow" clicked once.

Since 0.6.1 every secret is bundled into a single `secrets-bundle` JSON item (`{ version: 1, device, tokens, configs }`). Net effects:
- 1 OS prompt per process at most, instead of 3-5.
- Migration is lazy and transparent: when no bundle is present, the legacy individual items are read on first load, then the next `save()` writes the bundle and deletes the legacy items best-effort.
- The lossy-keychain safety net is preserved — secrets stay in `store.json` (mode 0600) when the bundle write fails.
- Corrupt bundle falls back to the legacy reads, then rewrites a clean bundle on next save.

The keychain backend interface (`KeychainBackend.get/set/delete`) is unchanged — the bundle is purely a Store-side packaging decision.

## Evolution — 0.8.0: keychain removed

The multi-instance Store design above is unchanged and still current. The **keychain-backed** half is not: 0.8.0 deletes `src/gateway/keychain.ts` and every keychain branch in the Store. Secrets now resolve from the environment (`.env` loaded by `src/gateway/env-file.ts`) then `store.json` (mode 0600). The rationale — an unauditable `spawnSync` into the OS credential store was costing user trust for a threat-model gain that mode 0600 already provided — is recorded in [ADR-006](006-env-file-secrets-no-keychain.md).

Everything above about `configs`, `defaultInstance`, per-gateway `tokens`, the v1 → v2 migration, `deviceIntegrity()` and `repairDevice()` still describes the shipped code. Read the keychain paragraphs (including the 0.6.1 bundle section) as history.
