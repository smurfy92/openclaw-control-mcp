# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
