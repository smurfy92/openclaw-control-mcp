# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- **Docs only.** README example replaced an internal job name (`spartners-veille-prospects`) with a generic placeholder (`<id>`) so the published examples no longer reference a private project. No code changes — the published tarball changes only `README.md` between 0.4.0 and 0.4.1.

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
