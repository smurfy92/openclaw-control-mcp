# ADR-006 — File-based secrets (`.env` + `store.json`), no OS keychain

**Status:** Accepted
**Date:** 2026-07-28
**Supersedes:** the keychain half of [ADR-001](001-multi-instance-store-with-keychain-backed-secrets.md) (the multi-instance Store design in ADR-001 stands unchanged)

## Context

Since 0.5.0 the Store pushed every secret into the OS keychain by default: macOS via the `security` CLI, Linux via `secret-tool`. Technically it worked — 0.6.1 even collapsed N items into a single bundle to cut the prompt count to one. The problem was never correctness, it was **trust**:

1. **An opaque OS prompt is a stop sign.** An MCP server the user just installed with `npx` triggers a macOS dialog asking to access the login keychain. Users who can't audit what the process is doing reasonably decline — and a declined prompt looks like a broken install, not a refused permission.
2. **`spawnSync("security", …)` is unauditable from the outside.** "This npm package shells out to my keychain" is a legitimate red flag, and no amount of README reassurance removes it.
3. **The threat model barely justified it.** The keychain protects against another *local user* reading the file — but `store.json` was already mode 0600, which covers exactly that. Against a process running as the user (the realistic threat for a dev machine), the keychain buys nothing: that process can call `security` too.
4. **Env-var injection already existed** (`OPENCLAW_DEVICE_PRIVATE_KEY`, `OPENCLAW_DEVICE_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`, …) for CI, and is what security-conscious users asked for anyway.

## Decision

Remove the keychain entirely from every runtime path. Secrets resolve from two places, in this order:

1. **The environment** — real env vars win over everything, and a `.env` file is loaded into `process.env` at startup by `src/gateway/env-file.ts`. Candidates, highest precedence first: `$OPENCLAW_ENV_FILE`, `./.env`, `<configDir>/.env`. Nothing is ever overwritten, so a one-shot `OPENCLAW_GATEWAY_TOKEN=… npx openclaw-control-mcp` still wins.
2. **`store.json`** (mode 0600) — what `openclaw_setup` and the pairing flow write, so the zero-config experience is unchanged.

The `.env` parser is deliberately minimal: no variable interpolation, no multiline values, no shell expansion. A secret is taken literally. The loader warns (never blocks) when the file is group/other-readable.

The **only** remaining keychain code is `src/gateway/keychain-migrate.ts`: read-only, dynamically imported, and reachable exclusively through the explicit `--migrate-from-keychain` flag. It imports 0.5.0–0.7.0 secrets into `store.json` and *prints* the delete commands rather than running them — we never mutate the user's keychain.

## Consequences

**Positive**
- No OS prompt, no `spawnSync` into a credential store, nothing to trust beyond file permissions the user can `ls -l` themselves.
- One documented precedence chain (`env > .env > store.json`) instead of a store/keychain split whose active half depended on which CLI happened to be installed.
- Whole classes of bug disappear: the empty-`privateKey` failure mode (see [`docs/troubleshooting/empty-private-key.md`](../troubleshooting/empty-private-key.md)) existed only because a keychain write could silently no-op after the in-memory copy was blanked.
- Deleted `src/gateway/keychain.ts` (~170 lines) and the backend-resolution branch in the Store.

**Negative**
- Secrets sit in plaintext in `store.json`. Mitigation: mode 0600, plus `.env` as the documented alternative for users who'd rather the server never wrote a secret to disk at all. This is the same posture as `~/.netrc`, `~/.aws/credentials`, `~/.npmrc`, and `~/.docker/config.json`.
- Existing 0.5.0–0.7.0 users must run `--migrate-from-keychain` once (or re-pair). Surfaced in the CHANGELOG, the README upgrade note, and the `--health` output.

## Alternatives considered

- **Keep the keychain, default OFF.** Rejected: keeps the `spawnSync` code in the shipped bundle, so it doesn't answer the trust objection — only the prompt goes away.
- **`.env` only, no secrets in `store.json`.** Rejected: it breaks the "pair once and it just works" flow — after approval the user would have to hand-copy the device token into a file before anything worked.
- **Encrypt `store.json` with a passphrase.** Rejected: the passphrase has to live somewhere, and a non-interactive MCP server over stdio has no good place to prompt for it.
