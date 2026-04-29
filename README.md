# openclaw-control-mcp

[![npm](https://img.shields.io/npm/v/openclaw-control-mcp.svg)](https://www.npmjs.com/package/openclaw-control-mcp)
[![license](https://img.shields.io/npm/l/openclaw-control-mcp.svg)](./LICENSE)

MCP server bridging Claude Code (or any MCP client) to the OpenClaw gateway management plane via WebSocket JSON-RPC. **134 typed tools wrapping all 128 JSON-RPC methods** the gateway publishes — cron, sessions, agents, channels, chat, logs, models, usage, status/health, config, secrets, skills, exec/plugin approvals, wizard, doctor memory, nodes, voice (TTS / talk / voicewake) — plus device pairing and in-chat setup.

The upstream `openclaw-mcp` package only wraps `/v1/chat/completions`. This wrapper talks the JSON-RPC protocol used by the OpenClaw Control panel SPA, so you can operate on the full management plane (list / trigger / configure jobs, sessions, agents, channels …) directly from the assistant.

## Status

**0.3.0 / preview.** **134 typed tools wrapping the 128 JSON-RPC methods the gateway publishes** — cron, sessions, agents, channels, chat, logs, models, usage, status/health/heartbeats, config, secrets, skills, exec/plugin approvals, wizard, doctor.memory, node, tts/talk/voicewake, plus device pairing & in-chat setup. The two introspection tools `openclaw_introspect` (lists every method/event the gateway publishes in its `hello-ok`) and `openclaw_call` (escape hatch for any method) make new gateway endpoints reachable without waiting on a release.

WS connect + signed Ed25519 handshake working against a managed Hostinger gateway (verified `2026.4.12`). On first start, the wrapper generates a long-lived device identity, persists it under `${XDG_CONFIG_HOME:-~/.config}/openclaw-control-mcp/store.json` (mode `0600`), signs the `connect` frame, and surfaces the resulting pairing request id so you can approve it once via the Control panel. After approval the gateway issues a device token (in `hello-ok.auth.deviceToken`) which is cached per-gateway and used on subsequent connects to grant scopes.

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

> "Configure OpenClaw with gateway `wss://openclaw-xxx.srv.hstgr.cloud` and token `<your-token>`"

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
    "OPENCLAW_GATEWAY_URL": "wss://openclaw-xxx.srv.hstgr.cloud",
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

### Schema looseness

Most v0.3.0 wrappers use `z.passthrough()` for params — they accept the documented fields plus anything else, and pass them through to the gateway. This trades strict client-side validation for forward-compat: as the gateway evolves, calls don't break on new fields. The downside is you'll only learn about a wrong field when the gateway rejects the request. If you hit a "missing required property" error, look at the gateway's response — it tells you the exact wire shape — and either correct your call, or open an issue / PR to tighten the wrapper's Zod schema.

## Roadmap

- Auto-reconnect with backoff (currently single-shot — Claude Code respawns the stdio process on demand).
- Stream session messages back into the MCP client (currently `sessions.subscribe` registers server-side but stdio can't surface deltas to Claude Code).
- Tighten Zod schemas for the wrappers added in 0.3.0 — most use `passthrough()` until the gateway shape for each domain is fully nailed down. PRs welcome.

## Migrating from openclaw-claw-mcp (early adopters)

If you used the wrapper under its previous name (`openclaw-claw-mcp`):
- The Store automatically reads `~/.config/openclaw-claw-mcp/store.json` as a fallback when the new path is empty, so your paired device token keeps working.
- On the next successful connect, the new path (`~/.config/openclaw-control-mcp/store.json`) is created. You can then delete the old directory.
- Update the entry name in `~/.claude.json` from `openclaw-claw` to `openclaw-control` (purely cosmetic — only changes the tool prefix `mcp__openclaw-control__*`).
- The local working dir / build output keeps the same path you cloned to; nothing else needs moving.

## Caveats

- The protocol is reverse-engineered, not documented. Behaviour may change with gateway updates.
- The connect frame matches what `openclaw/openclaw/scripts/dev/gateway-smoke.ts` sends today (`client.id: "openclaw-ios"`, `mode: "ui"`, role + scopes per the iOS operator default). Different `client.id` values trigger different server policies — `openclaw-control-ui` and `openclaw-tui` for example require device identity *and* a secure-context origin.
- `OPENCLAW_DEBUG=1` logs every WS frame to stderr (truncated at 8 KB). Useful when comparing handshakes against the live Control panel SPA.
