# Security policy

## Supported versions

Only the latest minor on `main` receives security fixes. Older majors are not patched once a new major ships. Today (2026-05) that means **0.6.x and later**; everything pre-0.6 has been deprecated on npm.

## Reporting a vulnerability

If you find a vulnerability in `openclaw-control-mcp`, **do not open a public issue**. Use one of these channels instead:

- **Preferred**: open a private security advisory on GitHub — <https://github.com/smurfy92/openclaw-control-mcp/security/advisories/new>. This keeps the report private, lets us coordinate a fix and a CVE if needed, and credits you in the published advisory.
- Email is not currently maintained as a public channel. If the GitHub flow is unworkable for you, ping `@smurfy92` on the OpenClaw community channels and we'll move to a private channel.

We aim for an initial response within 5 business days and a patched release within 30 days for high-severity findings (RCE, auth bypass, secret leak). For lower-severity issues we'll communicate a timeline in the advisory thread.

## Scope

The MCP server exposes secret-bearing and side-effectful gateway operations to a LLM the operator drives via natural language. Specifically in-scope:

- **Auth bypass** on the HTTP transport (`OPENCLAW_HTTP_BEARER` check, timing-safe compare, refusal to bind public without bearer)
- **Secret leakage** from the on-disk store or `.env` file (file modes, `.env` parsing, env propagation across child processes, redaction in logs and errors)
- **Tool surface escape**: any way to call a tool the agent isn't supposed to reach (introspection bypass, schema bypass via `openclaw_call`)
- **Prompt-injection paths** where a gateway response can cause the MCP wrapper to misbehave (parser issues, JSON-decoder DoS, etc.)
- **Wire signing / Ed25519** handshake correctness (nonce reuse, signature replay)

Out-of-scope (please don't report as a security issue):

- Vulnerabilities **in the OpenClaw gateway itself** — report those to the OpenClaw maintainers.
- Vulnerabilities **in transitive dependencies** that have an upstream advisory but no exploit path through this wrapper. We track these via Dependabot and bump as fixes ship; see the [Unreleased] section of CHANGELOG.md for the current status.
- **DOS via legitimate tool calls** (e.g. asking the agent to call `cron.list` in a tight loop). The gateway rate-limits its own surface — we don't add a second rate-limit layer.

## Known dependency advisories

As of 2026-07-28 (`0.8.0`), `@modelcontextprotocol/sdk` is on `1.30.0`, which clears the `fast-uri`, `hono` and `ip-address` advisories that 0.7.0 shipped with. `npm audit` now surfaces a single remaining item:

| Package | Severity | Path | Applies to us? | Tracker |
|---|---|---|---|---|
| `esbuild` | low | `tsup → esbuild` (devDependency) | No — dev-server-on-Windows only, never runs in the published package | <https://github.com/advisories/GHSA-g7r4-m6w7-qqqr> |

`esbuild` is a build-time dependency and is not part of the published tarball (`files` ships `dist` only). We bump dependencies as patched releases appear.

## Hardening recommendations for operators

If you're running `openclaw-control-mcp` in production, follow this checklist:

1. Never set `OPENCLAW_HTTP_HOST=0.0.0.0` without `OPENCLAW_HTTP_BEARER`. The server refuses to start in that combination, but the policy is worth understanding.
2. Generate the bearer with `openssl rand -hex 32` (or equivalent), store it in a secret manager, rotate quarterly.
3. Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front when exposing the HTTP port off-host. The bearer alone is not a substitute for TLS.
4. Run the MCP under a non-root account and bind to a port `>1024` so a compromise doesn't grant elevated privileges.
5. For CI / service-account usage, prefer the env-credential path (`OPENCLAW_DEVICE_PRIVATE_KEY` + `OPENCLAW_DEVICE_TOKEN`) so the runner has no persistent secret state on disk. On a workstation the equivalent is a `chmod 600` `.env` — the server never writes secrets to disk when the identity comes from the environment.
6. Audit your gateway side: which device this MCP authenticates as, which scopes are granted, and whether the secrets it can read/write are restricted to what the agent actually needs.
