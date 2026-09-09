# Submission templates — directories and crosslinks

Action items to broadcast the package once the Phase 0 + Phase 1 renarrative is live. None require local code changes — copy-paste / one-click.

## Common metadata (reuse everywhere)

| Field | Value |
|---|---|
| Name | `openclaw-control-mcp` |
| npm | https://www.npmjs.com/package/openclaw-control-mcp |
| GitHub | https://github.com/smurfy92/openclaw-control-mcp |
| MCP Registry id | `io.github.smurfy92/openclaw-control-mcp` |
| Short tagline | The OpenClaw control plane MCP server — 143 typed tools |
| Long description (~280 chars) | The OpenClaw control plane MCP server. Operate the gateway's full management surface (cron, sessions, agents, channels, skills, secrets, doctor, …) from Claude Code, Cursor, or any MCP client. 143 typed tools wrapping every published JSON-RPC method. |
| Topics / tags | `mcp-server`, `openclaw`, `control-plane`, `management-plane`, `claude-code`, `cursor`, `typescript`, `devops`, `automation` |
| License | MIT |
| Install command | `npx -y openclaw-control-mcp` |
| Cursor deeplink | `cursor://anysphere.cursor-deeplink/mcp/install?name=openclaw-control&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9wZW5jbGF3LWNvbnRyb2wtbWNwIl19` |
| VS Code deeplink | `vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22openclaw-control-mcp%22%5D%7D` |

## Directory 1 — mcp.so

**URL**: https://mcp.so/submit

Form fields: copy from the table above. The submit form auto-fetches metadata from GitHub when you paste the repo URL, so most fields populate themselves — just verify the description and tags.

## Directory 2 — mcpmarket.com

**URL**: https://mcpmarket.com (look for "Submit a server" link in the footer, or open an issue at https://github.com/mcpmarket/mcpmarket if no form).

Form fields: name + npm + GitHub + short tagline + long description + tags. Same content as table.

## Directory 3 — playbooks.com

**URL**: https://playbooks.com/mcp

Indexed automatically from the MCP Registry. **No action needed** if `server.json` is up to date (we're already listed as `io.github.smurfy92/openclaw-control-mcp` since 0.4.2). Sanity check:

```bash
curl -s https://playbooks.com/mcp/openclaw-control-mcp 2>&1 | head -5
```

If 404, open an issue at https://github.com/Cinnamon/playbooks-mcp-directory to request a re-crawl.

## Directory 4 — lobehub.com plugins

**URL**: https://github.com/lobehub/lobe-chat-plugins/pulls

Submission flow: open a PR adding a manifest under `plugins/<id>/manifest.json`. Format reference: any existing entry under `plugins/`. Use the table values for `name`, `description`, `tags`, `homepage`, `repository`. Set `type` to `mcp` if the schema supports it; else `tool`.

## Crosslink issues

Both repos can be filed in one command each via `gh`:

### freema/openclaw-mcp

```bash
gh issue create \
  --repo freema/openclaw-mcp \
  --title "Related project: openclaw-control-mcp (control plane wrapper)" \
  --body "$(cat <<'EOF'
Hi! 👋

I'm maintaining [`openclaw-control-mcp`](https://github.com/smurfy92/openclaw-control-mcp), an MCP server wrapping the OpenClaw gateway's JSON-RPC management plane — 143 typed tools across the 128 published methods (cron, sessions, agents, channels, skills, secrets, doctor, config, …).

Our scope is intentionally complementary to yours:

- `openclaw-mcp` — handles chat / completions (the `/v1/chat` surface, what users *do* with the gateway)
- `openclaw-control-mcp` — handles control / management (the JSON-RPC control panel, how operators *manage* the gateway: list crons, inspect sessions, configure agents, rotate secrets, …)

Same protocol family, two disjoint use cases. Would you be open to mentioning each other in the README under a "Related projects" / "See also" section? Happy to add a reciprocal link on our side first if that's helpful.

Either way, thanks for shipping a solid OpenClaw MCP — it set the example to follow.
EOF
)"
```

### sandraschi/clawd-mcp

```bash
gh issue create \
  --repo sandraschi/clawd-mcp \
  --title "Related project: openclaw-control-mcp (full control plane wrapper)" \
  --body "$(cat <<'EOF'
Hi! 👋

I'm maintaining [`openclaw-control-mcp`](https://github.com/smurfy92/openclaw-control-mcp), an MCP server wrapping the OpenClaw gateway's JSON-RPC management plane — 143 typed tools across the 128 published methods.

Looks like our scopes overlap on agents/sessions/channels/skills with you having the FastMCP + webapp angle and ours being exhaustive on the JSON-RPC surface (crons, secrets, doctor, exec/plugin approvals, config schema, voice, doctor.memory.* …).

Would you be open to mentioning each other in the README under a "Related projects" / "See also" section? Different paths to similar use cases — operators picking openclaw on MCP get a better mental map if they see both options. Happy to add a reciprocal link on our side first.
EOF
)"
```

## Order of operations (suggested)

1. **mcp.so + mcpmarket** first — biggest discoverability lift, ~10 min for both.
2. **playbooks crawl check** — if 404, open the issue. Cheap.
3. **lobehub PR** — slightly more work, but a one-time PR.
4. **Crosslink issues** last — wait until the directories are populated so the linked-from page looks substantive.
