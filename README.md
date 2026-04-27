# openclaw-claw-mcp

MCP server bridging Claude Code (or any MCP client) to the OpenClaw gateway management plane (cron, sessions, agents, channels) via WebSocket JSON-RPC.

The upstream `openclaw-mcp` package only wraps `/v1/chat/completions`. This wrapper talks the JSON-RPC protocol used by the OpenClaw Control panel SPA, so you can list and trigger cron jobs (and more) directly from the assistant.

## Status

**0.1.0 / preview.** Six cron tools registered: `openclaw_cron_list`, `_status`, `_run`, `_runs`, `_remove`, `_add`. WS connect handshake is fully working against a managed Hostinger gateway (verified `2026.4.12`). The transport (`src/gateway/client.ts`) and tool registry (`src/tools/cron.ts`) are designed to be extended to sessions, agents, channels, skills, instances, and logs.

> **Known limitation — token-only sessions have no scopes.** The gateway grants `role: "operator"` on a token-only connect, but **no `operator.read` / `operator.write` / `operator.admin` scopes**. As a result, every `cron.*` (and any read-side method) returns `INVALID_REQUEST: missing scope: operator.read`. To get scopes, the client must enroll an Ed25519 device identity that you approve once via the Control panel. See [Roadmap](#roadmap) — **device pairing is the next PR**.

What works today end-to-end:
- WS upgrade + connect handshake (correct frame format, UUID request ids, full scope-less hello-ok response).
- `health` / `status` / unscoped methods (the `features.methods` list is returned and inspectable).
- Tool registry, JSON Schema (draft 2020-12 compatible), MCP stdio loop.

What does **not** work yet:
- Anything scoped (`cron.*`, `sessions.*`, `agents.*`, `channels.*`, …) until device pairing lands.

The wire format (frame types, field names, scopes) was reverse-engineered from the minified Control panel bundle (`/api-docs/assets/index-*.js`) and cross-checked against the official `scripts/dev/gateway-smoke.ts` in `openclaw/openclaw`. It is **not officially documented**. Behaviour may change without notice if OpenClaw updates the gateway.

## Install

```bash
cd /path/to/openclaw-claw-mcp
npm install
npm run build
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

Add an entry to `~/.claude.json` next to the existing `openclaw` server:

```json
"openclaw-claw": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<you>/path/to/openclaw-claw-mcp/dist/index.js"],
  "env": {
    "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18789",
    "OPENCLAW_GATEWAY_TOKEN": "<your gateway token>",
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

## Tools

| Tool | JSON-RPC method | Notes |
|---|---|---|
| `openclaw_cron_list` | `cron.list` | Filter by enabled state, search query, paginate |
| `openclaw_cron_status` | `cron.status` | Scheduler enabled flag + next run |
| `openclaw_cron_run` | `cron.run` | Trigger an immediate run by id |
| `openclaw_cron_runs` | `cron.runs` | Recent runs of a job |
| `openclaw_cron_remove` | `cron.remove` | **Destructive** |
| `openclaw_cron_add` | `cron.add` | Create new job with schedule + payload |

## Roadmap

### Next PR — Ed25519 device pairing (unblocks scopes)

The gateway only grants `operator.read/write/admin` to clients that present a paired device identity. Implementation outline:

1. Generate a long-lived Ed25519 keypair on first run, persist at `${XDG_CONFIG_HOME:-~/.config}/openclaw-claw-mcp/device.json` (`{ deviceId, publicKey, privateKey }`).
2. On `connect`, attach `device: { id, publicKey, signature, signedAt, nonce }` where `signature = ed25519(canonicalize({deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce}))`. The `nonce` comes from the `connect.challenge` event the gateway sends right after WS open.
3. First connect → server returns a pending pair request. Surface the device id to the user so they can approve it once via the Control panel (`device.pair.approve`). Server response should then carry a `deviceToken` with scopes.
4. Persist the device token alongside the keypair, send it as `auth.deviceToken` on subsequent connects.
5. Handle `AUTH_DEVICE_TOKEN_MISMATCH` / `recommendedNextStep: retry_with_device_token` by clearing the cached token and re-pairing.

Reference: `nt(...)`, `Mn(...)`, `Gn(...)`, `Kn(...)` in `assets/index-*.js` (Control panel bundle).

### Then

- Sessions (`sessions.list/get/delete`)
- Agents (`agents.list/files/skills`)
- Channels (`channels.list/send/broadcast`)
- Skills (`skills.list/report`)
- Instances (`instances.list/usage`)
- Logs (`logs.tail/search`)
- Auto-reconnect with backoff (currently single-shot — Claude Code respawns the stdio process on demand)

## Caveats

- The protocol is reverse-engineered, not documented. Behaviour may change with gateway updates.
- The connect frame matches what `openclaw/openclaw/scripts/dev/gateway-smoke.ts` sends today (`client.id: "openclaw-ios"`, `mode: "ui"`, role + scopes per the iOS operator default). Different `client.id` values trigger different server policies — `openclaw-control-ui` and `openclaw-tui` for example require device identity *and* a secure-context origin.
- `OPENCLAW_DEBUG=1` logs every WS frame to stderr (truncated at 8 KB). Useful when comparing handshakes against the live Control panel SPA.
