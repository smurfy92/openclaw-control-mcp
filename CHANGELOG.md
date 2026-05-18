# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`SECURITY.md`** policy file added at the repo root. Documents the reporting channel (private GitHub security advisory), the in-scope vs out-of-scope surface, the current state of the 4 transitive advisories inherited from `@modelcontextprotocol/sdk@1.29.0` (none fixable in this wrapper, all tracked upstream), and a 6-step hardening checklist for operators running the HTTP transport.

### Changed

- **`types` + `exports` fields** added to `package.json`. `dist/index.d.ts` is now advertised as the type entrypoint, and the `exports` map declares the package and `package.json` as the only public entries. Fixes the "no type declarations advertised" and "missing entry points" warnings on Socket-style supply-chain scanners. `files` whitelist now also ships `SECURITY.md`.

### Added

- **Bearer-token auth for the HTTP transport.** `OPENCLAW_HTTP_BEARER` (or `--http-bearer=<token>`) gates every `/mcp` request with a constant-time `Authorization: Bearer <token>` check (`crypto.timingSafeEqual`). Mismatched or missing headers get `401 Unauthorized` with a `WWW-Authenticate: Bearer realm="openclaw-control-mcp"` response. Binding to a non-loopback host (`0.0.0.0`, public IP) without a bearer now refuses to start instead of exposing every tool unauthenticated — loopback-without-bearer still starts but logs a loud warning. ADR-005 (Streamable HTTP transport) marked Accepted at this point. 8 new vitest cases covering the bearer-check helper (218 total, was 210).

### Documentation

- **README repositioned around the "control plane MCP server" narrative.** New `Without vs with` problem/solution intro, `Quickstart` section with one-click install deeplinks for Cursor (`cursor://anysphere.cursor-deeplink/mcp/install?…`) and VS Code (`vscode:mcp/install?…`), and `claude mcp add` one-liner. The differentiator vs the upstream `openclaw-mcp` (which only wraps `/v1/chat/completions`) is now stated explicitly in the lead paragraph.
- **`Threat model` section** added — explicit handling of the secret surface (`config.*` / `secrets.*` writes, `openclaw_call` escape hatch, `OPENCLAW_DEVICE_PRIVATE_KEY` env credentials, prompt-injection risk from gateway-returned content), pointer to the GitHub security advisory form.
- README badges expanded: monthly downloads, Node engine. Roadmap mentions HTTP/SSE transport and Claude Desktop Extension packaging as the next two scope-expanding items.

### Added

- **Env-based device credentials** for headless / CI usage. `OPENCLAW_DEVICE_PRIVATE_KEY` (base64url Ed25519 seed) and `OPENCLAW_DEVICE_TOKEN`, when set, take priority over the on-disk store. `publicKey` and `deviceId` are derived from the private key, so only one secret needs rotating to change the identity. Optional `OPENCLAW_DEVICE_ROLE` and `OPENCLAW_DEVICE_SCOPES` (comma-separated) override the defaults. Unblocks stateless runners (GitHub Actions, ephemeral containers, service accounts) which previously hit `GatewayError: pairing required` because each invocation generated a fresh ephemeral device. 11 new vitest cases (210 total, was 199).
- **`docs/ci-device-secrets.md`** — runbook for provisioning the secrets, both by extracting them from an existing local keychain bundle (Option A) and by creating a dedicated CI device (Option B).

### Changed

- **`scripts/verify-all-tools.ts` resolves credentials env-first**, matching `src/index.ts`. Without this, running the verify script from a CI runner with `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` set but no on-disk store failed immediately with "no gateway configured" because `Store.loadConfig()` only reads the persisted state.

### Internals

- **`.github/workflows/drift-watch.yml`** — weekly + on-demand workflow that runs `verify:live` on a self-hosted runner, uploads the JSON report as a 90-day artifact, and opens a labelled issue on drift (or on a fatal run failure). Self-hosted because the gateway port isn't reachable from GitHub Actions' hosted IP ranges.
- `toBase64Url` / `fromBase64Url` exported from `src/gateway/device.ts` so the env-credential helper can reuse them.

## [0.6.2] — 2026-05-13

### Fixed

- **`OPENCLAW_GATEWAY_TOKEN` alone now works.** Setting only the token env var (without `OPENCLAW_GATEWAY_URL` alongside) used to silently fall back to the on-disk store and ignore the env value — so `OPENCLAW_GATEWAY_TOKEN=… node dist/index.js --health` sent `auth: {}` to the gateway and got back `unauthorized: gateway token missing`. The credential resolution is now per-field: env wins when set, store fills in the rest. Empty strings in the store (post-wipe state) are treated as missing. New `mergeCreds` helper in `src/gateway/store.ts` + 5 unit tests pin the behaviour.

## [0.6.1] — 2026-05-10

### Changed

- **Single-item OS keychain bundle** — every secret (device private key, per-gateway device tokens, gateway tokens, gateway passwords) now lives in one `secrets-bundle` JSON item instead of N individual items. On macOS this drops the keychain access prompt count from 3-5 to 1 per process. Migration is lazy and transparent: when no bundle is present, the legacy individual items are still read on first load, and the next `save()` writes the bundle and deletes the legacy items best-effort. No env var to opt out — opting out of the keychain entirely (`OPENCLAW_USE_KEYCHAIN=0`) keeps the pre-0.5 plain-JSON behaviour.

### Added

- 3 new vitest cases covering bundle migration: legacy-only read fallback, first-save migrates and deletes legacy items, corrupt bundle falls back to legacy reads (194 total, was 191).

### Documentation

- **Wrapper passthrough fields** (`config.set.value`, `config.patch.mergeValue`, `node.invoke.params`, `system_event.payload`) now describe the intentional `z.unknown()` JSON-RPC passthrough in their Zod `.describe()` so MCP clients see the contract.

## [0.6.0] — 2026-05-09

> **Note**: this version was released alongside a `git filter-repo` history scrub that removed all personal/internal references (specific project names, real Discord/Telegram IDs, gateway hostnames) from prior commits. The npm tarballs of pre-0.6.0 versions remain immutable on the registry — they were deprecated with a redirect-to-0.6.0 message. Forks/clones predating 2026-05-09 should re-clone to pick up the rewritten history.

### Added

- **`openclaw_secrets_set`** tool — convenience wrapper that pushes an arbitrary secret (API key, third-party token, …) into the gateway config tree via `config.patch` with a synthesized `mergePath`. Default scope is `secrets` (writes `config.secrets.<name>`); override with `scope` for skill-scoped secrets like `tools.linkedin-outreach`. The gateway has no `secrets.set` JSON-RPC method (only `reload` + `resolve`, and `resolve` is command-scoped, not arbitrary KV) — this tool fills that gap by leveraging `config.patch`.
- **Architectural smoke test** (`tests/architectural.test.ts`) — vitest assertion that every registered tool wraps its input schema in `withInstance`, follows the `openclaw_*` naming convention, has no name collisions, has a non-empty description, and exports an async handler. Caught `openclaw_device_repair` missing `withInstance` on first run; that's the bug class it'll prevent in the future.
- **`scripts/verify-all-tools.ts`** + `npm run verify:live` — pre-release regression guard. Boots the configured gateway client, round-trips ~45 read-only probes through the typed wrappers, and emits a JSON / human-readable report classifying outcomes as `ok` / `wrapper-zod-error` / `gateway-invalid-request` (= drift) / `gateway-other-error`. Exits non-zero on drift so CI can gate on it. CLI flags: `--json`, `--out report.json`, `--include foo,bar`, `--exclude doctor`. SEND-style tools (agent, send, chat.send, sessions.send) are excluded — probing them would trigger real agent turns / channel deliveries.
- **`docs/integrations/linkedin-proxycurl-migration.md`** — generic reference pattern for migrating a `linkedin-outreach`-style skill from `li_at` cookie scraping to Proxycurl with cookie fallback. No personal/project references.

### Fixed (schema drifts caught by verify:live during this cycle)

- **`openclaw_wizard_status` requires `sessionId`** (verified live against gateway 2026.4.12+). Wrapper had `z.object({}).passthrough()` and the gateway always rejected. Now requires the field.
- **`openclaw_agent` is NOT read-only** despite the previous description claiming so (verified live: gateway requires `message` + `idempotencyKey`). Renamed semantics: it's a SEND that triggers an agent turn. Wrapper now requires `message`, auto-generates `idempotencyKey` from `crypto.randomUUID()` when omitted. Description updated to reflect side-effects.
- **`openclaw_send` requires `to` + `idempotencyKey`** (verified live: gateway's root `send` is channel-routed delivery). Wrapper had soft `agentId/sessionId/text` shape with everything optional; the `text` field is rejected as `unexpected property`. Schema tightened to require `to` and auto-generate `idempotencyKey`.
- **`chat.*` family aligned with `sessionKey`-based wire format** (verified live):
  - `openclaw_chat_send` now requires `sessionKey` + `message` + auto `idempotencyKey`. The pre-0.5.x `agentId/sessionId/text` shape was rejected by the gateway.
  - `openclaw_chat_history` now requires `sessionKey`; accepts `limit`. The pre-0.5.x `agentId/sessionId/offset` fields are rejected.
  - `openclaw_chat_abort` now requires `sessionKey`. The pre-0.5.x `agentId/sessionId` fields are rejected.
- **`openclaw_talk_mode` requires `enabled: boolean`** (verified live: it's a SETTER, not a getter as the description implied). Use `openclaw_talk_config` for read access.

### Changed

- **MockGateway expanded from ~20 to ~80 methods** with realistic state transitions. Workflow chains now work end-to-end in mock mode: `sessions.create → chat.send → chat.history` (sees the user message AND an auto-generated assistant reply); `agents.create → agents.list` (persisted); `exec.approval.request → list → resolve` (status flips correctly); `cron.add → list → run → runs` (full lifecycle). Mock now mirrors the live wire-format requirements (e.g. `chat.send` rejects missing `idempotencyKey`, `secrets.resolve` requires `commandName`, `wizard.status` requires `sessionId`) so end-to-end tests catch the same drifts the live probe does. Unrecognised methods still return the generic `{ mock: true, ok: true, note: "extend src/gateway/mock.ts" }` stub.
- **`logs.tail` mock returns `lines: string[]`** (matches the real wire format the wrapper expects). Pre-fix the mock returned `entries: [...]` which the wrapper would silently see as empty. Bug latent since 0.5.0.

### Internals

- New `scripts/probe-secrets.ts`, `scripts/probe-agent-method.ts`, `scripts/probe-chat-history.ts`, `scripts/probe-chat-and-voice.ts` — standalone live probes used to discover the schema drifts above. Kept under `scripts/` for future audits.
- 35 new vitest cases (191 total, was 156): architectural invariants (5), chat.* schema tightening (5), talk.mode schema (1), agent/send auto-idempotency (2), wizard.status (1), instance arg forwarding (1), tool count sanity (1), MockGateway workflow chains (19).
- `openclaw_device_repair` schema wrapped in `withInstance` (caught by the new architectural test on first run — the test paid for itself before the commit even landed).
- `MockGateway` refactored from one big switch to a route-table dispatcher with handler methods grouped by domain (~590 lines, +400 vs pre-fix). Each domain (chat, sessions, agents, channels, exec.approval, …) is a focused block.

## [0.5.1] — 2026-05-09

### Fixed (reliability)

- **Stale WS — `device nonce mismatch` now auto-recovers.** `isTransientError` matches `/nonce mismatch|stale[_\s-]?nonce/i` on `GatewayError`, so the existing retry loop (which already drops cached client + nonce between attempts) triggers a fresh handshake on the next attempt. When the retry budget is exhausted (4 attempts), the wrapped error message includes an actionable hint pointing at `openclaw_setup` and the troubleshooting doc. Resolves bug documented in [`docs/troubleshooting/stale-connection-nonce-mismatch.md`](./docs/troubleshooting/stale-connection-nonce-mismatch.md) — was the most painful UX issue in 0.5.0 (user had to re-run `openclaw_setup` after every idle period).
- **Empty `device.privateKey` — three-layer fix.** (1) `Store.stripSecretsToKeychain` no longer blanks `privateKey` when the keychain `set` call throws — the secret stays in the on-disk JSON (mode 0600) instead of being lost. Same for tokens, gatewayToken, gatewayPassword. (2) `signConnect` now pre-checks key length and throws a typed `DevicePrivateKeyMissingError` with actionable steps instead of the cryptic `expected Uint8Array of length 32, got length=0` from noble. (3) New tool **`openclaw_device_repair`** backs up `store.json` to `store.json.bak.<ts>`, wipes the broken device + cached tokens, drops matching keychain entries, and surfaces a clear next-step. Configs (gatewayUrl, gatewayToken) are preserved. Resolves bug from [`docs/troubleshooting/empty-private-key.md`](./docs/troubleshooting/empty-private-key.md).

### Added

- **`openclaw_device_repair`** tool — single-purpose recovery from the empty-private-key inconsistency. Destructive (wipes device + tokens) but non-destructive on gateway configs. Run only when `openclaw_device_status` reports the failure mode.
- **`Store.deviceIntegrity()`** + **`Store.repairDevice()`** — public Store API for callers that need to inspect or reset device state programmatically.
- **`DevicePrivateKeyMissingError`** class exported from `gateway/device.ts`.
- **`isStaleNonceError`** helper exported from `gateway/client.ts`.
- **4 ADRs** in `docs/adr/` formalizing the load-bearing architectural decisions (Store, ToolClient, shim, introspect-and-call). Each anchored in source via `// ADR-NNN` comment. Surfaced after `codegraph-toolkit` flagged these files as articulation points without documented rationale.

### Removed

- **`smithery.yaml`** at the repo root. Smithery's current publish flow expects an HTTP-accessible MCP server (each user shares the same endpoint), which doesn't fit a per-user client like this one (each user has their OWN gateway URL + token). The package stays distributed via npm (`npx -y openclaw-control-mcp`) and the official MCP Registry (`io.github.smurfy92/openclaw-control-mcp`). Re-add the manifest if Smithery reintroduces a stdio-launch flow with per-user config.

### Internals

- Cleanup from codegraph audit (one-shot) — 8 `export` removed on local-only types (`GatewayClientOptions`, `SignConnectInput`, `GatewayConfigShape`, `StoreShape`, `LastHello`, `SetupHooks`, `MockCall`, `MockClientHandle`); `Store.hydrateSecretsFromKeychain` refactored to drop nesting from 5 to 3 levels via `readWithLegacyFallback` helper; `err.retryable === true` → `err.retryable` in `isTransientError`.
- 19 new vitest cases (150 total, was 131): 4 stale-nonce handling, 5 privateKey integrity / repair / signConnect assertion, 8 sessions.list & logs.tail filter pass-through (already in 0.5.0 but tests added retroactively), 2 misc.
- Bundle 141.66 → 146.45 KB (+5 KB for the reliability fixes + repair tool).

## [0.5.0] — 2026-05-07

### Added

- **Per-call `instance` parameter on every tool.** Each of the ~134 tools now accepts an optional `instance` field (e.g. `{ instance: "work" }`) so a single MCP can target a different gateway per call without flipping the active default first. Useful for cron jobs that fan out across multiple gateways from one Claude Code session.
- **HTTP transport** (Streamable HTTP, MCP spec 2024-11-05+). Run with `--http` (or `OPENCLAW_HTTP=1`) to expose the MCP at `http://127.0.0.1:3333/mcp` instead of stdio. Configure with `--http-port=N` / `--http-host=H` or `OPENCLAW_HTTP_PORT` / `OPENCLAW_HTTP_HOST`. Stateful mode (per-client session id) so concurrent clients don't clobber each other. Unblocks Cursor / Continue / Cline / Zed wiring.
- **4 cron template tools** that synthesize the `cron.add` wire format so callers don't have to remember `schedule.kind` / cron expressions:
  - `openclaw_cron_add_weekly` — `(name, dayOfWeek, hour, minute, tz, message, channel?, to?)` → `0 H * * D` cron expression
  - `openclaw_cron_add_daily` — `(name, hour, minute, tz, message, …)` → `0 H * * *`
  - `openclaw_cron_add_every` — `(name, intervalMinutes | intervalHours, message, …)` → `kind: "every"`, `everyMs` computed
  - `openclaw_cron_add_once` — `(name, at, message, …)` → `kind: "exact"` + `deleteAfterRun: true`. Auto-validates RFC3339.
  All four accept the standard `agentId` / `model` / `timeoutSeconds` / `channel` / `to` / `deliveryMode` knobs and the per-call `instance` param.
- **Mock mode** (`OPENCLAW_MOCK=1` or `--mock`). Swaps the WebSocket client for an in-memory `MockGateway` with canned responses for the most-used JSON-RPC methods (cron.{list,add,update,remove,run,runs}, sessions.{list,preview,create}, config.{get,patch}, status, health, gateway.identity.get, agents.list, models.list, secrets.reload, logs.tail). Lets callers exercise the full MCP surface without provisioning a real gateway — handy for CI, demos, and dry-runs before touching prod. Un-canned methods return `{ mock: true, ok: true, note: "extend src/gateway/mock.ts to specialise" }` so nothing crashes.
- **`config.patch` convenience flow.** Pass `{ mergePath, mergeValue }` and the wrapper auto-fetches `config.get`, deep-merges your value at the dotted path, computes the resulting `raw` JSON, and submits with the freshly-read `baseHash`. The advanced `{ raw, baseHash }` shape is still available for callers that need full control over the optimistic-locking flow.
- **`tests/helpers/mock-client.ts`** — shared `makeMockClient()` helper (replaces the duplicated stub patterns in per-call-instance / wrapper-fixes / cron-templates tests). Exposes `setNextResponse` and `setRequestHandler` for stateful mocks.

### Changed

- **Keychain default ON.** When a usable OS keychain backend is detected (macOS `security`, Linux `secret-tool`), secrets are split into the keychain on save instead of staying in `store.json`. Set `OPENCLAW_USE_KEYCHAIN=0` (or `false`) to opt out and keep the 0.4.x plain-JSON behaviour. Migration is lazy: existing 0.4.x users on plain JSON keep working until the next `Store.save()` (typically the next gateway connect that refreshes the device token), at which point secrets move to the keychain automatically.
- **Tool factories now take a `ToolClient` interface** instead of the concrete `GatewayClient` class. The shim implements `ToolClient`, routing each call to the cached client for the requested instance. Tools never see the real `GatewayClient` anymore — per-call routing stays consistent.

### Fixed

- **`openclaw_call` no longer mis-encodes `params`.** The Zod schema was tightened from `z.unknown()` to `z.record(z.string(), z.unknown())` so strings, arrays, and primitives are rejected at the wrapper instead of reaching the gateway as a non-object payload (which produced the cryptic `invalid X.Y params: must be object` error). Object params and omitted params (defaults to `{}`) work as documented. Reproduced live and confirmed against gateway 2026.4.12.
- **`openclaw_cron_update` aligned with the gateway's wire format.** Old shape `{ job: { id, ...fields } }` is auto-translated into the new `{ id|jobId, patch }` shape (verified live: gateway anyOf accepts both `id` and `jobId`). Pre-0.5.0 callers keep working without changes; new callers can pass `{ id, patch: {...} }` directly. Wrapper-level error if neither id nor jobId is provided, with an actionable message.
- **`openclaw_config_get` `path` filter now does client-side projection.** The gateway never accepted a `path` param (rejected with `unexpected property 'path'`). The wrapper now fetches the full config and applies the dotted path projection against the parsed tree, returning `{ ...originalResponse, projectedPath, projected }`. No change for callers that don't pass `path`.
- **`openclaw_config_patch` aligned with the gateway's optimistic-locked wire format `{ raw: string, baseHash: string }`** (raw is the *full* config serialized as JSON, baseHash from a previous `config.get`). The pre-0.5.0 `{ path, value }` shape was rejected by the gateway and is now rejected at the wrapper with a message pointing to the new shapes.
- **`openclaw_sessions_list` `status` filter now applied client-side.** The gateway rejects `status` with `INVALID_REQUEST: unexpected property 'status'`. The wrapper now forwards only `agentId` / `limit` / `offset` to the gateway and filters the returned `sessions[]` array by `status` after fetch. Surfaces a `statusFilter` field in the response for transparency.
- **`openclaw_logs_tail` `sinceMs` / `level` / `component` filters now applied client-side.** The gateway rejects all three with `INVALID_REQUEST: unexpected property 'X'`. Only `limit` reaches the wire. Each line's `_meta.date` / `_meta.logLevelName` / message text is parsed and filtered in-process. Surfaces a `clientFilter` field with `{ sinceMs, level, component, kept, dropped }`.

### Internals

- New `src/tools/client.ts`: `ToolClient` interface, `withInstance` Zod helper, `splitInstance`, `passthroughHandler`. The 25 tool files refactored mechanically via these helpers.
- New `src/gateway/mock.ts`: in-memory `MockGateway` for the new mock mode.
- New `src/tools/cronTemplates.ts`: 4 new cron template tools.
- 46 new vitest cases (131 total, was 85 in 0.4.3): 9 per-call instance routing, 12 wrapper-format fixes, 9 cron templates, 8 MockGateway, 8 schema-drift filters.
- New `scripts/repro-bugs.ts`, `scripts/verify-fixes.ts`, `scripts/verify-fixes-2.ts` — standalone live-gateway probes used to validate the schema fixes. Kept under `scripts/` (not in the npm tarball).
- Bundle size 116.57 → 141.66 KB (+25 KB for HTTP transport, mock mode, cron templates, per-call routing helpers, client-side filter logic).

## [0.4.3] — 2026-05-01

### Added

- **`openclaw_sessions_tail`** — polling tool that watches a session via `sessions.preview` for up to 5 minutes and returns ONLY the messages that arrived during the tail window. Workaround for stdio MCP not being able to stream `sessions.subscribe` / `session.message` events to the client. Stops early on terminal status (`done` / `error` / `aborted` / `timeout` / `completed`) or once `maxMessages` new messages are collected. Defaults: 30s window, 2s poll interval. Concrete user value: "watch this agent reply" workflow.

### Internals

- 84 vitest cases passing (76 → 84, +8 covering the new tail tool: schema bounds, defaults, deduplication, three early-stop conditions).
- Bundle size 111.79 → 116.57 KB (+4.78 KB for the tail orchestrator + helpers).

## [0.4.2] — 2026-05-01

### Added

- **`mcpName` field in `package.json`** (`io.github.smurfy92/openclaw-control-mcp`) — required for ownership validation against the official MCP Registry (`registry.modelcontextprotocol.io`).
- **`server.json`** at repo root — MCP Registry manifest (schema 2025-12-11) pointing at npm package 0.4.2 with stdio transport.
- **`smithery.yaml`** at repo root — Smithery (smithery.ai) startCommand manifest invoking `npx -y openclaw-control-mcp`.

### Notes

- 0.4.1 was tagged on git but never published to npm. 0.4.2 supersedes it on npm. The 0.4.1 git tag and GitHub Release remain in the history.
- Both `server.json` and `smithery.yaml` are excluded from the npm tarball via the existing `files` whitelist.

## [0.4.1] — 2026-05-01

### Changed

- **Docs only.** README example replaced a project-specific cron job name with a generic `<id>` placeholder so the published examples no longer reference any private project. No code changes — the published tarball changes only `README.md` between 0.4.0 and 0.4.1.

## [0.4.0] — 2026-04-29

### Added

- **Multi-instance gateway configs** — a single MCP can manage multiple OpenClaw gateways (e.g. `perso` and `work`). Existing single-instance setups auto-migrate to `configs.default`. Pass `instance` to `openclaw_setup` / `openclaw_setup_show` / `openclaw_setup_clear` to target a specific one.
- **`openclaw_setup_list`** — enumerate every persisted instance (name + URL + token-set state, never values).
- **`openclaw_setup_select_default`** — switch the active default instance. Subsequent tool calls (cron, sessions, agents, …) automatically route to the new default after this call. Existing client connections are closed so they re-handshake with the new credentials.
- **`Store.loadConfigs()`**, **`Store.setDefaultInstance()`**, **multi-instance keychain key namespacing** (`gateway-token:<instance>` instead of `gateway-token`).
- **Opt-in OS keychain backend** for device + gateway secrets (`OPENCLAW_USE_KEYCHAIN=1`) — macOS `security` CLI, Linux `secret-tool`, Windows/no-keychain falls back to legacy plain JSON. `Store.secretsLocation()` exposes the active backend through `openclaw_setup_show` and `--health`.

### Changed

- **`cron.add` Zod schema aligned with the gateway wire format** — `expr` / `tz` instead of `cronExpr` / `cronTz`, `everyMs` instead of `everyAmount` + `everyUnit`, `at` instead of `scheduleAt`, `payload.message` + `payload.timeoutSeconds` instead of `payload.text` only. Fixes silent rejection from the gateway when callers trusted the schema's old field names. (`openclaw_cron_update` was already aligned in 0.3.0.)
- **`Store` schema bumped from v1 to v2** with auto-migration on first load.
- **Session + agent tool descriptions enriched** — `key` vs `sessionId`, observed `status` values, `text`/`message` and `content`/`body` aliases documented inline.

### Internals

- 76 vitest cases passing (66 → 76, +12 cron schemas, +10 multi-instance store, +14 keychain).
- `readShape()` accepts `version: 1` and `version: 2` for forward / backward compat.

## [0.3.2] — 2026-04-29

### Added

- **`--health` CLI flag**: `npx -y openclaw-control-mcp --health` runs a one-shot diagnostic (config, connect, gateway version, paired state, last-success age) and prints a JSON report. Exits non-zero on failure. Use this for quick "is everything OK?" checks without wiring the MCP into a client.
- **Coverage report inside `openclaw_introspect`**: a new `coverage` field lists methods the gateway publishes that *this MCP* doesn't yet wrap (`unwrappedMethods`) and the inverse drift (`wrappedButNotPublished`). Catches gateway-version drift early.
- **Configurable retry policy**: `OPENCLAW_RETRY_ATTEMPTS` (default 4, range 1–10) and `OPENCLAW_RETRY_BASE_MS` (default 1000, range 100–60000) env vars tune the retry/backoff behaviour added in 0.3.1.

### Changed

- **Enriched request errors**: when a request gives up (transient error after max attempts, or non-retryable error), the thrown error now carries `gateway request '<method>' failed (attempt N/M):` as a prefix and the original error attached as `cause`. `GatewayError`'s code/details/retryable fields are preserved through the wrap.
- **MCP server version is now read from `package.json`** instead of being hard-coded — keeps `Server` metadata in sync with the published version automatically.

## [0.3.1] — 2026-04-29

### Added

- **Auto-reconnect with exponential backoff** in `client.request()`: 1s → 2s → 4s, max 4 attempts. Non-retryable errors fail fast.
- **`openclaw_health`** combines server-side `health` JSON-RPC with client-side metadata: MCP version, gateway URL, paired device fingerprint, granted scopes, `lastSuccessAgo`.
- **`cron.runs` compact mode** (`compact: true`) truncates each run's `summary` to 200 chars (configurable) and adds `summaryTruncated` + `runAtAgo` per entry.
- **README "Examples"** section with copy-paste prompts per domain.
- **Tests + CI**: 37 vitest cases (format helpers, version reader, transient-error classification, Ed25519 sign/verify roundtrip). GitHub Actions runs typecheck, test, build on Node 22 & 24.

### Internals

- New helpers: `src/format.ts` (`formatDuration`, `formatAgo`, `truncate`), `src/version.ts` (`getMcpVersion`).
- Exported `isTransientError()` for testability.
- Tracked `lastSuccessAtMs` on the client.

## [0.3.0] — 2026-04-29

### Added

- **First public release on npm**: https://www.npmjs.com/package/openclaw-control-mcp
- **134 typed tools wrapping all 128 JSON-RPC methods** the gateway publishes in `hello-ok.features.methods`: cron, sessions, agents, channels, chat, logs, models, usage, status, config, secrets, skills, exec/plugin approvals, wizard, doctor.memory, node, tts/talk/voicewake, plus device pairing & in-chat setup.
- **`openclaw_introspect` + `openclaw_call`**: introspection of the gateway methods + escape hatch for any method without a typed wrapper.
- LICENSE (MIT), repository/homepage/bugs/keywords in `package.json`, README oriented at npm install via `npx`.

## [0.2.0] — 2026-04-27

### Added

- In-chat configuration via `openclaw_setup({ gatewayUrl, gatewayToken })` — no more `~/.claude.json` editing required.
- `openclaw_setup_show` and `openclaw_setup_clear` for inspection and cleanup.

## [0.1.0] — 2026-04-27

### Added

- Initial wrapper for the OpenClaw gateway management plane via WebSocket JSON-RPC.
- Ed25519 device pairing, signed connect, persisted device token under `~/.config/openclaw-control-mcp/`.
- Cron-domain tools (`cron.list`, `cron.status`, `cron.run`, `cron.runs`, `cron.add`, `cron.remove`).
