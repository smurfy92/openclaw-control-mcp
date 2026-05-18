# openclaw-control-mcp

[![npm](https://img.shields.io/npm/v/openclaw-control-mcp.svg)](https://www.npmjs.com/package/openclaw-control-mcp)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-control-mcp.svg)](https://www.npmjs.com/package/openclaw-control-mcp)
[![CI](https://github.com/smurfy92/openclaw-control-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/smurfy92/openclaw-control-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/openclaw-control-mcp.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/openclaw-control-mcp.svg)](https://www.npmjs.com/package/openclaw-control-mcp)

**The OpenClaw control plane MCP server.** Operate the gateway's full management surface from Claude Code, Cursor, or any MCP client — list and trigger crons, inspect sessions, configure agents and channels, manage skills and secrets, drive the doctor memory plane, pair devices, approve exec/plugin calls. **134 typed tools** covering every JSON-RPC method the gateway publishes.

![demo](docs/assets/demo.gif)

> Different from the upstream [`openclaw-mcp`](https://www.npmjs.com/package/openclaw-mcp), which only wraps `/v1/chat/completions`. This one talks the JSON-RPC protocol used by the OpenClaw Control panel — so you can operate the gateway itself (its crons, sessions, agents, channels, skills, secrets, …), not just chat through it.

## Without vs with

**Without `openclaw-control-mcp`** — you bounce between the Control panel UI, your terminal, and Claude Code. "List my crons" means opening the SPA. "Tail this agent session" means staying in the panel and refreshing. "Why did this skill fail?" means hunting through `logs.tail` manually. The assistant can chat through the gateway but it cannot **operate** it.

**With `openclaw-control-mcp`** — the same assistant queries `openclaw_cron_list`, follows up with `openclaw_sessions_tail` to watch a turn in flight, asks `openclaw_skills_status` for diagnostic data, rotates a secret via `openclaw_secrets_set`, and approves a stuck `openclaw_exec_approval` — without you ever leaving the chat. The Control panel becomes an *audit interface*, not a daily-driver.

## Quickstart

```bash
# Claude Code — registers a stdio server under the default config
claude mcp add openclaw-control -- npx -y openclaw-control-mcp
```

One-click install from supported clients:

[![Install in Cursor](https://img.shields.io/badge/Cursor-install-black?logo=cursor)](cursor://anysphere.cursor-deeplink/mcp/install?name=openclaw-control&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9wZW5jbGF3LWNvbnRyb2wtbWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/VS%20Code-install-blue?logo=visualstudiocode)](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22openclaw-control-mcp%22%5D%7D)

On first start the wrapper generates an Ed25519 device identity and surfaces a `pairing request id`. Approve it once in the OpenClaw Control panel, the gateway issues a device token, and every subsequent call uses it transparently. Full pairing flow below.

## Status

**0.6.2** — published on npm, indexed on the official MCP Registry as `io.github.smurfy92/openclaw-control-mcp`. Multi-instance gateway configs, OS keychain-backed secret storage, 134 typed tools across the 128 published JSON-RPC methods, plus two escape hatches: `openclaw_introspect` enumerates every method/event the gateway publishes in its `hello-ok`, and `openclaw_call` lets you reach any method that doesn't have a typed wrapper yet — so new gateway endpoints are reachable without waiting on a release.

The Ed25519 signed handshake is verified live against gateway `2026.4.12+`. On first start, the wrapper generates a long-lived device identity, persists it under `${XDG_CONFIG_HOME:-~/.config}/openclaw-control-mcp/store.json` (mode `0600`) — or in the OS keychain when available — signs the `connect` frame, and surfaces the resulting pairing request id so you can approve it once via the Control panel. After approval the gateway issues a device token (in `hello-ok.auth.deviceToken`) which is cached per-gateway and used on subsequent connects to grant scopes.

The wire format (frame types, field names, signing canonicalisation, scopes) was reverse-engineered from the minified Control panel bundle (`/api-docs/assets/index-*.js`) and cross-checked against `openclaw/openclaw/scripts/dev/gateway-smoke.ts`. It is **not officially documented**. Behaviour may change without notice if OpenClaw updates the gateway.

## First-run / pairing flow

1. Start the wrapper (Claude Code does this automatically once registered in `~/.claude.json`).
2. Ask Claude to run `openclaw_device_status`. The first call:
   - generates an Ed25519 keypair and persists it to disk,
   - opens a WS to the gateway,
   - sends a signed `connect` frame,
   - the gateway replies with `PAIRING_REQUIRED` and a `requestId`,
   - the tool returns `{ pendingPairing: { requestId }, nextStep: "approve in Control panel…" }`.
3. Open the OpenClaw Control panel → **Devices** tab → approve the request whose id matches.
4. Ask Claude to run `openclaw_device_status` again. This time the gateway accepts the connect, returns `auth.deviceToken` in `hello-ok`, the wrapper caches it, and `paired: true` plus the granted scopes appear in the response.
5. From then on, scoped tools (`openclaw_cron_list`, `_status`, …) work normally.

## Install

### From npm (recommended)

```bash
claude mcp add openclaw-control -- npx -y openclaw-control-mcp
```

Restart Claude Code, then jump to [Configuration](#configuration).

### From source (for contributors)

```bash
git clone https://github.com/smurfy92/openclaw-control-mcp.git
cd openclaw-control-mcp
npm install
npm run build
claude mcp add openclaw-control -- node "$(pwd)/dist/index.js"
```

## Configuration

The wrapper requires the **WebSocket** URL of your OpenClaw gateway. The public Hostinger HTTPS hostname does not expose the WS endpoint — you need the URL the Control panel itself uses internally.

Find it from your browser:
1. Open the Control panel and log in.
2. In the DevTools console run:
   ```js
   Object.entries(localStorage).find(([k]) => k.startsWith("openclaw.control.settings.v1"))?.[1]
   ```
3. Copy the `gatewayUrl` field (typically `ws://127.0.0.1:18789`, a Tailscale `ws://100.x.y.z:18789`, or a dedicated `wss://…` host).

## Use with Claude Code

### Recommended: register, then configure in chat

The slickest path — no `~/.claude.json` editing, no env vars. After installing (npx or from source), in chat:

> "Configure OpenClaw with gateway `wss://your-gateway.example.com` and token `<your-token>`"

Claude calls `openclaw_setup({ gatewayUrl, gatewayToken })`, the values get persisted to `~/.config/openclaw-control-mcp/store.json` (mode `0600`). The next call to `openclaw_device_status` triggers the WS handshake and pairing flow.

`openclaw_setup_show` reports the effective configuration, `openclaw_setup_clear` wipes the persisted config (without touching the device identity / token).

### Alternative: env-var-driven

If you prefer env vars (they take precedence over the stored config), edit `~/.claude.json`:

```json
"openclaw-control": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "openclaw-control-mcp"],
  "env": {
    "OPENCLAW_GATEWAY_URL": "wss://your-gateway.example.com",
    "OPENCLAW_GATEWAY_TOKEN": "<your-token>",
    "OPENCLAW_TIMEOUT_MS": "30000"
  }
}
```

Restart Claude Code — `openclaw_cron_list` and friends will be available.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | yes | WebSocket URL of the gateway (`ws://` or `wss://`) |
| `OPENCLAW_GATEWAY_TOKEN` | recommended | Gateway login token |
| `OPENCLAW_GATEWAY_PASSWORD` | optional | Extra password (some gateway configs require it) |
| `OPENCLAW_TIMEOUT_MS` | optional | Connect / request timeout (default 30000) |
| `OPENCLAW_DEBUG` | optional | Set to `1` to log every WS frame to stderr |
| `OPENCLAW_CONTROL_HOME` | optional | Override the directory used to persist `store.json` (defaults to `${XDG_CONFIG_HOME:-~/.config}/openclaw-control-mcp/`). The legacy `OPENCLAW_CLAW_HOME` is still read as a fallback. |
| `OPENCLAW_USE_KEYCHAIN` | optional | Default ON since 0.5.0 — secrets land in the OS keychain (macOS `security`, Linux `secret-tool`) when one is available, else stay in `store.json`. Since 0.6.1 every secret is collapsed into a single keychain item (one OS prompt per process instead of 3-5). Click "Always Allow" once to clear future prompts on the same install. Set the env var to `0` or `false` to opt out and force plain JSON. |
| `OPENCLAW_HTTP` | optional | Set to `1` to expose the MCP over Streamable HTTP at `/mcp` instead of stdio. Equivalent to passing `--http`. |
| `OPENCLAW_HTTP_PORT` | optional | HTTP port (default `3333`). Equivalent to `--http-port=N`. |
| `OPENCLAW_HTTP_HOST` | optional | HTTP host (default `127.0.0.1`). Equivalent to `--http-host=H`. |
| `OPENCLAW_MOCK` | optional | Set to `1` (or pass `--mock`) to swap the WebSocket gateway for an in-memory `MockGateway`. Lets you exercise the MCP without provisioning a real gateway — for CI, demos, or dry-runs. State is kept in-process and discarded on exit. |

## Multi-instance: per-call `instance` parameter

Every tool accepts an optional `instance` field so a single MCP can target several gateways without flipping the active default first:

```jsonc
// route this one call to the 'work' gateway, regardless of the active default
{ "name": "openclaw_cron_list", "arguments": { "instance": "work", "limit": 10 } }
```

Configure each gateway with `openclaw_setup({ instance: "work", gatewayUrl, gatewayToken })`, list them with `openclaw_setup_list`, switch the active default with `openclaw_setup_select_default`. When `OPENCLAW_GATEWAY_URL` is set in the env, it overrides everything (including a `instance` arg) — the env-var path always wins.

## HTTP mode

For clients that don't speak stdio (Cursor, Continue, Cline, Zed, browser), run the MCP as a Streamable HTTP server:

```bash
# Loopback (default 127.0.0.1:3333), no bearer — fine for local trust
npx -y openclaw-control-mcp --http --http-port=3333

# Same, but with bearer auth on (recommended even on loopback)
OPENCLAW_HTTP=1 OPENCLAW_HTTP_BEARER="$(openssl rand -hex 32)" \
  npx -y openclaw-control-mcp

# Bound to a public interface — bearer is REQUIRED (server refuses to start without)
OPENCLAW_HTTP=1 OPENCLAW_HTTP_HOST=0.0.0.0 OPENCLAW_HTTP_PORT=3333 \
  OPENCLAW_HTTP_BEARER="$(openssl rand -hex 32)" \
  npx -y openclaw-control-mcp
```

Endpoint: `POST/GET http://<host>:<port>/mcp` (MCP Streamable HTTP, stateful — each client gets its own session id). Stdio remains the default; the HTTP server only starts when explicitly enabled.

**Auth behaviour:**

- `OPENCLAW_HTTP_BEARER` set → every `/mcp` request must include `Authorization: Bearer <token>`. Mismatched / missing tokens get `401 Unauthorized` with a `WWW-Authenticate: Bearer realm="openclaw-control-mcp"` header. Comparison is constant-time.
- `OPENCLAW_HTTP_BEARER` unset + bound to loopback → starts with a stderr warning. Anyone with local shell access can invoke every tool.
- `OPENCLAW_HTTP_BEARER` unset + bound to a non-loopback host (`0.0.0.0`, public IP, etc.) → the server **refuses to start**. Public binding without auth is a takeover risk and not negotiable.

For long-lived deployments behind a reverse proxy, terminate TLS at the proxy (nginx, Caddy, Traefik) and forward to `127.0.0.1:3333/mcp` — the bearer protects the proxy → MCP hop too.

## Mock mode (no gateway required)

Set `OPENCLAW_MOCK=1` (or pass `--mock`) to swap the WebSocket client for an in-memory mock. Useful for:

- **CI** — run tests / demos without a live gateway.
- **Workflow rehearsals** — dry-run a sequence of `cron.add` / `cron.update` / `config.patch` calls before pointing at prod.
- **Onboarding** — try the MCP without provisioning a gateway instance.

```bash
# stdio
OPENCLAW_MOCK=1 npx -y openclaw-control-mcp
# or HTTP
OPENCLAW_MOCK=1 OPENCLAW_HTTP=1 npx -y openclaw-control-mcp
```

State (cron jobs added, config patches, sessions) is kept in-process and discarded on exit. The mock seeds one cron job (`sample-weekly`) and one session so list calls return non-empty. Methods without a canned handler return `{ mock: true, ok: true }` so nothing crashes — extend `src/gateway/mock.ts` to specialise additional methods.

## Cron templates (no schedule syntax to remember)

Four wrappers on top of `cron.add` synthesize the wire format for the most common cases:

```jsonc
// every Friday at 09:00 Paris, send a weekly digest to a Telegram channel
{ "name": "openclaw_cron_add_weekly", "arguments": {
    "name": "weekly-digest", "dayOfWeek": "fri", "hour": 9, "minute": 0,
    "tz": "Europe/Paris", "message": "Compose the weekly digest …",
    "channel": "telegram", "to": "-1001234567890"
}}

// every day at 07:00 UTC
{ "name": "openclaw_cron_add_daily", "arguments": {
    "name": "morning-check", "hour": 7, "tz": "UTC", "message": "Run the morning checks."
}}

// every 15 minutes (clock-agnostic)
{ "name": "openclaw_cron_add_every", "arguments": {
    "name": "ping", "intervalMinutes": 15, "message": "ping the upstream"
}}

// one-shot reminder, auto-deletes after firing
{ "name": "openclaw_cron_add_once", "arguments": {
    "name": "remind-meeting", "at": "2026-12-25T09:00:00+01:00",
    "message": "Don't forget the holiday call."
}}
```

All four take the standard knobs: `agentId?`, `model?`, `timeoutSeconds?` (default 900), `channel? + to?`, `deliveryMode?` (`announce` | `direct` | `none`), `instance?`.

## Tools

134 typed tools wrapping the **128 JSON-RPC methods** the gateway publishes (and 2 standalone introspection tools). Run `openclaw_introspect` once paired to see the live list of methods + events on your specific gateway.

### Introspection (no scopes required)

| Tool | Notes |
|---|---|
| `openclaw_introspect` | Returns server version, your role/scopes, and the full `methods[]` / `events[]` list the gateway publishes in its `hello-ok`. |
| `openclaw_call` | **Escape hatch** — call any JSON-RPC method with arbitrary params. Useful when the gateway adds new methods between releases. Prefer typed wrappers when they exist. |

### Setup (no scopes required)

| Tool | Notes |
|---|---|
| `openclaw_setup` | Persist `{ gatewayUrl, gatewayToken, gatewayPassword? }` to local config. |
| `openclaw_setup_show` | Report effective config (env vs store), without printing tokens. |
| `openclaw_setup_clear` | Wipe persisted gateway config. Device identity + tokens are kept. |

### Device & pairing (`device.pair.*`, `device.token.*`)

`openclaw_device_status` / `openclaw_device_pair_list` / `_pair_approve` / `_pair_reject` / `_pair_remove` / `openclaw_device_token_revoke` / `_token_rotate`. Manages your local Ed25519 identity and the per-gateway tokens it's been issued.

### Coverage by domain (require `operator.read` / `operator.write` / `operator.admin`)

| Domain | Tools | JSON-RPC methods wrapped |
|---|---|---|
| `cron` | 7 | `list` `status` `run` `runs` `add` `update` `remove` |
| `sessions` | 17 | `list` `preview` `create` `patch` `send` `abort` `reset` `delete` `compact` `compaction.{list,get,restore,branch}` `subscribe/unsubscribe` `messages.subscribe/unsubscribe` |
| `agents` | 7 | `list` `create` `update` `delete` `files.{list,get,set}` |
| `chat` | 3 | `send` `history` `abort` |
| `channels` | 2 | `status` `logout` |
| `logs` | 1 | `tail` |
| `models` | 1 | `list` |
| `usage` | 2 | `status` `cost` |
| Root status | 12 | `status` `health` `last-heartbeat` `set-heartbeats` `system-presence` `system-event` `wake` `send` `agent` `agent.identity.get` `agent.wait` `gateway.identity.get` |
| `config` | 6 | `get` `set` `patch` `apply` `schema` `schema.lookup` |
| `secrets` | 2 | `reload` `resolve` |
| `skills` | 6 | `status` `search` `detail` `install` `update` `bins` |
| `tools` | 2 | `tools.catalog` `tools.effective` |
| `exec.approval` | 9 | `list` `get` `request` `resolve` `waitDecision` + global / per-node policy `get/set` |
| `plugin.approval` | 4 | `list` `request` `resolve` `waitDecision` |
| `wizard` | 4 | `start` `next` `cancel` `status` |
| `doctor.memory` | 7 | `status` `dreamDiary` `backfillDreamDiary` `dedupeDreamDiary` `repairDreamingArtifacts` `resetDreamDiary` `resetGroundedShortTerm` |
| `node` | 16 | `list` `describe` `invoke` + `invoke.result` `event` `rename` `pair.{request,verify,approve,reject,list}` `pending.{ack,drain,enqueue,pull}` `canvas.capability.refresh` |
| `tts` | 6 | `status` `enable` `disable` `providers` `setProvider` `convert` |
| `talk` | 3 | `config` `mode` `speak` |
| `voicewake` | 2 | `get` `set` |
| Misc | 3 | `update.run` `commands.list` `message.action` |

Tool names follow `openclaw_<domain>_<method>`. Method-name dots become underscores: `cron.list` → `openclaw_cron_list`, `sessions.compaction.restore` → `openclaw_sessions_compaction_restore`.

### Destructive tools

These carry destructive side effects (data loss, service interruption, revoked access). Their `description` is marked accordingly so Claude Code's confirmation gate prompts before each call:

- **Cron**: `cron_remove`, `cron_run` (real execution), `cron_update`
- **Sessions**: `sessions_{abort,reset,delete,compaction_restore}`
- **Agents**: `agents_{delete,files_set}`
- **Chat**: `chat_abort`
- **Channels**: `channels_logout`
- **Device**: `device_{pair_remove,token_revoke,token_rotate}`
- **Config**: `config_{set,patch,apply}`
- **Secrets**: `secrets_resolve` (returns secret material)
- **Doctor memory**: `doctor_memory_{resetDreamDiary,resetGroundedShortTerm,repairDreamingArtifacts,backfillDreamDiary,dedupeDreamDiary}`
- **Node**: `node_{invoke,rename,pending_drain,pending_enqueue,pending_ack,pair_approve,pair_reject}`
- **Skills**: `skills_{install,update}`
- **Approvals**: `exec_approval_resolve`, `exec_approvals_{set,node_set}`, `plugin_approval_resolve`
- **Self-update**: `update_run` (gateway-wide, may interrupt sessions)

## Examples

Copy-paste prompts you can drop into Claude after the MCP is paired. Each one targets the corresponding tool and shows the kind of natural-language phrasing that resolves to a concrete call.

### Health & sanity

```
> Run a full openclaw health check.
```

→ Calls `openclaw_health`, reports MCP version, gateway server version, paired device fingerprint, granted scopes, and how recently the last successful call ran.

```
> What gateway methods do I have access to right now?
```

→ Calls `openclaw_introspect`, returns the 128 JSON-RPC methods + 24 events the gateway publishes in its `hello-ok`.

### Cron

```
> List all openclaw cron jobs, including disabled ones.
```

→ `openclaw_cron_list({ enabled: "all" })`.

```
> Show me the last 5 runs of cron job <id> — compact mode, just the summaries.
```

→ `openclaw_cron_runs({ id: "<job-id>", limit: 5, compact: true })` — summaries truncated to 200 chars, each entry gets a `runAtAgo: "3d ago"` field.

```
> Create a cron that runs every Friday at 1pm Paris and posts a summary to Telegram group -1001234567890.
```

→ Generates an `openclaw_cron_add` payload with the right `schedule.kind: "cron"`, `expr: "0 13 * * 5"`, `tz: "Europe/Paris"`, and `delivery.mode: "announce"`.

### Sessions

```
> List the 10 most recent active openclaw sessions, ranked by last activity.
```

→ `openclaw_sessions_list({ limit: 10, sortBy: "updatedAt", sortDir: "desc" })`.

```
> Show me the last 8 messages of session agent:main:cron:<id>.
```

→ `openclaw_sessions_preview({ keys: ["agent:main:cron:<id>"] })` — returns role/text turns straight from the gateway.

### Agents & channels

```
> List the agents configured on this gateway and which model they use.
```

→ `openclaw_agents_list`.

```
> What's the connection state of my Telegram channel?
```

→ `openclaw_channels_status`.

### Escape hatch

```
> Use openclaw_call to invoke "config.schema" with no params and return the keys it exposes.
```

→ Useful when a gateway-side method doesn't yet have a typed wrapper, or you want to inspect a feature still in beta.

## Resilience

`request()` retries transient errors (network drop, ws close, timeout, DNS) with **exponential backoff**: defaults to 1s → 2s → 4s, max 4 attempts. Non-retryable errors (`PAIRING_REQUIRED`, `INVALID`, `MISSING_SCOPE`, etc.) fail fast — no point retrying a permission issue. Tune via:

- `OPENCLAW_RETRY_ATTEMPTS` — total attempts (default `4`, range `1`–`10`)
- `OPENCLAW_RETRY_BASE_MS` — initial backoff in ms (default `1000`, range `100`–`60000`)
- `OPENCLAW_DEBUG=1` — prints every retry decision to stderr

When a request gives up, the thrown error carries `gateway request '<method>' failed (attempt N/M):` as a prefix and the original error is preserved as `cause` for inspection. `GatewayError` `code` / `details` / `retryable` flags are propagated through the wrap.

The client tracks `lastSuccessAtMs` for `openclaw_health`'s `lastSuccessAgo` field — useful for "is the gateway still talking to me?" debug.

## Diagnostic CLI

For one-shot health checks without wiring the MCP into a client:

```bash
npx -y openclaw-control-mcp --health
```

Prints a JSON report (MCP version, gateway URL, paired state, scopes, server version, last-success age, error if any) and exits non-zero on failure. Handy in CI / scripts.

### Schema looseness

Most v0.3.0 wrappers use `z.passthrough()` for params — they accept the documented fields plus anything else, and pass them through to the gateway. This trades strict client-side validation for forward-compat: as the gateway evolves, calls don't break on new fields. The downside is you'll only learn about a wrong field when the gateway rejects the request. If you hit a "missing required property" error, look at the gateway's response — it tells you the exact wire shape — and either correct your call, or open an issue / PR to tighten the wrapper's Zod schema.

## Threat model

This MCP server exposes secret-bearing and side-effectful gateway operations (`config.*`, `secrets.*`, `cron.run`, `sessions.send`, `agent`, channel send) to an LLM that the operator drives via natural language. Treat that surface deliberately:

- **The gateway token, device private key, and per-gateway device tokens** are persisted under `${XDG_CONFIG_HOME:-~/.config}/openclaw-control-mcp/store.json` (file mode `0600`) and — when an OS keychain is available — bundled into one keychain item (macOS `security`, Linux libsecret). The store file alone never contains plaintext secrets when the keychain is active. Never commit the store or post screenshots of `--health` output unredacted.
- **`openclaw_secrets_set` writes into the gateway config tree** via `config.patch`. Any tool call that reaches this wrapper rotates the underlying secret in the gateway's view. Wrap it with explicit human confirmation in agent prompts.
- **`openclaw_call` is an escape hatch** — it forwards arbitrary JSON-RPC method calls. The gateway enforces per-scope permissions, but on the client side there's no input filter. Limit which tool catalogs your agent can see if untrusted prompts can reach it.
- **`OPENCLAW_DEVICE_PRIVATE_KEY` / `OPENCLAW_DEVICE_TOKEN` env vars** (for headless / CI / service-account usage) take priority over the store. Set them only in trusted execution contexts (GitHub secrets, K8s secrets, password manager exports — not in shell history, Docker `--env`, or `.env` files committed to the repo).
- **Prompt-injection surface**: the gateway's responses (session previews, logs, agent outputs) feed back into the MCP client and can carry attacker-controlled content. Treat any tool output as untrusted when deciding whether to call destructive tools (the destructive list is published in §Destructive tools — confirm before chaining a write tool to a read tool output).
- **HTTP transport surface**: when running `--http`, the server enforces a constant-time `Bearer` check if `OPENCLAW_HTTP_BEARER` is set, refuses to bind to a non-loopback interface without one, and emits a loud stderr warning if started on loopback without one. Rotate the bearer like a gateway admin token — anything that can read it can invoke every tool, including `secrets.*` writes. Terminate TLS at a reverse proxy before exposing the HTTP port to the network.

If you find a vulnerability, please open a private security advisory on GitHub rather than a public issue: <https://github.com/smurfy92/openclaw-control-mcp/security/advisories/new>.

## Roadmap

- Auto-reconnect with backoff (currently single-shot — Claude Code respawns the stdio process on demand).
- Stream session messages back into the MCP client (currently `sessions.subscribe` registers server-side but stdio can't surface deltas to Claude Code).
- Tighten Zod schemas for the wrappers added in 0.3.0 — most use `passthrough()` until the gateway shape for each domain is fully nailed down. PRs welcome.
- HTTP / SSE transport in addition to stdio, to enable Cursor remote and Claude.ai web custom-connector use.
- Claude Desktop Extension (`.mcpb`) packaging.

## Migrating from openclaw-claw-mcp (early adopters)

If you used the wrapper under its previous name (`openclaw-claw-mcp`):
- The Store automatically reads `~/.config/openclaw-claw-mcp/store.json` as a fallback when the new path is empty, so your paired device token keeps working.
- On the next successful connect, the new path (`~/.config/openclaw-control-mcp/store.json`) is created. You can then delete the old directory.
- Update the entry name in `~/.claude.json` from `openclaw-claw` to `openclaw-control` (purely cosmetic — only changes the tool prefix `mcp__openclaw-control__*`).
- The local working dir / build output keeps the same path you cloned to; nothing else needs moving.

## Troubleshooting

- **`gateway request '…' failed: expected Uint8Array of length 32, got length=0`** — the persisted `device.privateKey` is empty (keychain backend silently failed at `stripSecretsToKeychain`). Workaround + proposed fixes: [`docs/troubleshooting/empty-private-key.md`](./docs/troubleshooting/empty-private-key.md).
- **`gateway request '…' failed: device nonce mismatch`** after some idle time — the WS connection went stale and the retry loop reuses a burned nonce. Workaround: re-call `openclaw_setup` with the same params (forces a fresh handshake). Details + proposed fixes: [`docs/troubleshooting/stale-connection-nonce-mismatch.md`](./docs/troubleshooting/stale-connection-nonce-mismatch.md).

## Caveats

- The protocol is reverse-engineered, not documented. Behaviour may change with gateway updates.
- The connect frame matches what `openclaw/openclaw/scripts/dev/gateway-smoke.ts` sends today (`client.id: "openclaw-ios"`, `mode: "ui"`, role + scopes per the iOS operator default). Different `client.id` values trigger different server policies — `openclaw-control-ui` and `openclaw-tui` for example require device identity *and* a secure-context origin.
- `OPENCLAW_DEBUG=1` logs every WS frame to stderr (truncated at 8 KB). Useful when comparing handshakes against the live Control panel SPA.
