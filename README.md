# openclaw-claw-mcp

MCP server bridging Claude Code (or any MCP client) to the OpenClaw gateway management plane (cron, sessions, agents, channels) via WebSocket JSON-RPC.

The upstream `openclaw-mcp` package only wraps `/v1/chat/completions`. This wrapper talks the JSON-RPC protocol used by the OpenClaw Control panel SPA, so you can list and trigger cron jobs (and more) directly from the assistant.

## Status

**0.1.0 / preview.** Tools registered:
- Cron: `openclaw_cron_list`, `_status`, `_run`, `_runs`, `_remove`, `_add` (need `operator.read` scope).
- Device: `openclaw_device_status`, `openclaw_device_pair_list`, `openclaw_device_pair_approve`, `openclaw_device_pair_reject`.

WS connect + signed Ed25519 handshake working against a managed Hostinger gateway (verified `2026.4.12`). On first start, the wrapper generates a long-lived device identity, persists it under `${XDG_CONFIG_HOME:-~/.config}/openclaw-claw-mcp/store.json` (mode `0600`), signs the `connect` frame, and surfaces the resulting pairing request id so you can approve it once via the Control panel. After approval the gateway issues a device token (in `hello-ok.auth.deviceToken`) which is cached per-gateway and used on subsequent connects to grant scopes.

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
| `OPENCLAW_CLAW_HOME` | optional | Override the directory used to persist `store.json` (defaults to `${XDG_CONFIG_HOME:-~/.config}/openclaw-claw-mcp/`) |

## Tools

### Pairing / device

| Tool | JSON-RPC method | Notes |
|---|---|---|
| `openclaw_device_status` | (local + `connect`) | Reports local device id, pending pairing request id, paired state, granted scopes. Re-runs a connect each call so it doubles as "retry pairing after approval". |
| `openclaw_device_pair_list` | `device.pair.list` | List pending + paired devices on the gateway. Requires `operator.read`. |
| `openclaw_device_pair_approve` | `device.pair.approve` | Approve a pending request by id. Requires `operator.write`. |
| `openclaw_device_pair_reject` | `device.pair.reject` | Reject a pending request by id. |

### Cron (require operator.read / operator.write)

| Tool | JSON-RPC method | Notes |
|---|---|---|
| `openclaw_cron_list` | `cron.list` | Filter by enabled state, search query, paginate |
| `openclaw_cron_status` | `cron.status` | Scheduler enabled flag + next run |
| `openclaw_cron_run` | `cron.run` | Trigger an immediate run by id |
| `openclaw_cron_runs` | `cron.runs` | Recent runs of a job |
| `openclaw_cron_remove` | `cron.remove` | **Destructive** |
| `openclaw_cron_add` | `cron.add` | Create new job with schedule + payload |

## Roadmap

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
