# ADR-005 — Streamable HTTP transport alongside stdio

**Status:** Proposed
**Date:** 2026-05-16

## Context

Today the MCP server runs on stdio only — Claude Code spawns a child process per session and exchanges JSON-RPC frames on its stdin/stdout. That's the natural model for a local assistant, but it has hard limits:

- **Cursor remote workspaces** can't reach a stdio process running on the user's laptop. They need an HTTP endpoint they can `fetch` from their VM.
- **Claude.ai custom connectors** (the web-based assistant) only support HTTP transports — stdio is unreachable from the browser.
- **Multi-tenant deployments** (one MCP server, several team members) need a network-addressable surface. Spawning a per-user stdio is wasteful and doesn't share session state.
- **CI / service-account usage** is currently bolted on via env credentials (ADR coming) but a long-lived HTTP server with bearer auth is a more natural fit for "Claude calls into this every 5 min".

The MCP spec landed [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) as the standard HTTP transport, with SSE marked legacy. The SDK 1.x bundles `@modelcontextprotocol/sdk/server/streamableHttp` (Node Express) and `@modelcontextprotocol/sdk/server/webStandardStreamableHttp` (Web Standard / Workers / Bun) as ready-to-use server transports.

## Decision

Add **Streamable HTTP** as a second transport, selectable at startup via `--transport streamable-http` (default stays `stdio` for back-compat). One binary, one tool catalog, two surfaces.

**Configuration shape:**

| Env / CLI | Default | Purpose |
|---|---|---|
| `--transport stdio` (default) | stdio | Existing behaviour, no change |
| `--transport streamable-http` | — | Boots an HTTP server |
| `OPENCLAW_HTTP_PORT` | `3845` | Listening port |
| `OPENCLAW_HTTP_HOST` | `127.0.0.1` | Bind address (loopback by default; opt-in to public via `0.0.0.0`) |
| `OPENCLAW_HTTP_BEARER` | required | Pre-shared secret checked on every HTTP call |
| `OPENCLAW_HTTP_PATH` | `/mcp` | MCP endpoint mount path |

**Auth layer:** Bearer token in `Authorization: Bearer <token>` header. Server rejects with `401` if missing/wrong. No OAuth2, no per-user token issuance — that's a future iteration. The bearer token is the equivalent of the gateway admin token at the HTTP layer.

**Per-instance routing:** the existing `instance` per-call parameter still selects which OpenClaw gateway to talk to (ADR-002 + ADR-003). One HTTP server can fan out to N gateway instances exactly like the stdio binary does today.

**SSE skipped:** the SDK ships an SSE transport for back-compat with 2024 clients, but Cursor / Claude.ai / Claude Desktop have all moved to Streamable HTTP. Shipping both is twice the auth + lifecycle surface for marginal client coverage. We'll add SSE only if a tracked client requests it.

## Consequences

**Positive**
- Cursor remote workspaces, Claude.ai custom connectors, and remote agents become possible without architecture changes elsewhere.
- The drift-watch CI pattern (`OPENCLAW_DEVICE_PRIVATE_KEY` + `OPENCLAW_DEVICE_TOKEN` env injection) can be replaced by a long-lived HTTP server with bearer auth — the auth surface is then one secret per *runner*, not per *device*.
- HTTP transport unblocks Phase 2's MCPB (Claude Desktop Extension) packaging, where a `.mcpb` manifest can advertise both stdio (for local) and HTTP (for remote) entrypoints.

**Negative**
- Adds an HTTP server dependency and the auth surface that goes with it. `express` is already pulled in transitively by `@modelcontextprotocol/sdk/server/streamableHttp`, so no new top-level dep, but the bearer-token check is hand-rolled middleware and a usual source of bugs (timing-safe comparison, header parsing, …).
- A second transport doubles the integration-test surface. Architectural smoke test (`tests/architectural.test.ts`) will need a transport-agnostic version.
- Public HTTP exposure (when `OPENCLAW_HTTP_HOST=0.0.0.0`) requires TLS in front. We document that — we don't ship our own TLS terminator. Defaults stay loopback-only.

**Files anchored** — `src/transports/streamableHttp.ts` (new, marker `// ADR-005`), `src/index.ts` (transport selector at boot).

## Alternatives considered

- **Legacy SSE transport only.** Rejected — deprecated upstream, no traction in 2026 clients.
- **`webStandardStreamableHttp` (Workers / Bun)** instead of the Express-based `streamableHttp`. Promising for edge deployment but adds a fetch-adapter shim; tracked as ADR-006 if a deployment target asks for it.
- **Drop stdio entirely.** Rejected — Claude Code stays the largest user surface and ships natively over stdio. Coexistence is cheap once the transport selector is in place.
- **OAuth2 device flow instead of bearer.** Rejected for v0.7. Bearer is good enough for the operator-as-tenant use case; OAuth lands when per-user token issuance becomes necessary (Claude.ai connector marketplace).

## Implementation plan (high-level)

1. **Transport selector** in `src/index.ts` (`--transport stdio|streamable-http`, env fallback `OPENCLAW_TRANSPORT`). Default stdio. Boot path branches once; the rest of the server (tool registry, gateway client cache, instance routing) stays unchanged.
2. **`src/transports/streamableHttp.ts`** — boots `StreamableHTTPServerTransport` from the SDK on `OPENCLAW_HTTP_HOST:OPENCLAW_HTTP_PORT`, mounts auth middleware that checks `Authorization: Bearer ${OPENCLAW_HTTP_BEARER}` with a timing-safe compare, registers the MCP server on the chosen path.
3. **Tests** — `tests/transports-http.test.ts` covering the 401 surface (no header, wrong token, malformed header), the `200 OK` happy path with a forged MCP frame, and binding behaviour (loopback default, 0.0.0.0 only when explicit).
4. **Documentation** — README section `## Run as an HTTP server`, `.env.example` snippet, threat-model addendum (TLS, bearer rotation, exposure surface).
5. **Smoke test** — wire `npm run verify:live -- --transport streamable-http` (the verify script reuses the same `ToolClient` interface so it doesn't care about transport; it only needs the HTTP endpoint to dispatch to).
6. **Release** as 0.7.0 (minor — new capability, no breaking changes for existing stdio users).

Total effort estimate: 1-2 days for the happy path + ~1 day for tests + docs. Aiming for a 0.7.0 release within 1 week of starting.
