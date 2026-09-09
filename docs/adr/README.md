# Architecture Decision Records

Short, focused records of the load-bearing architectural choices. Each ADR is
anchored in one source file via a `// ADR-NNN` comment at the top — the
toolkit (and any future reviewer) can trace from code to rationale and back.

## Format

See [`_TEMPLATE.md`](_TEMPLATE.md). Keep ADRs under 50 lines: title, context,
decision, consequences (positive + negative + files anchored), 1-2
alternatives considered.

## Index

| # | Title | File anchored |
|---|---|---|
| [001](001-multi-instance-store-with-keychain-backed-secrets.md) | Multi-instance Store (keychain half superseded by 006) | `src/gateway/store.ts` |
| [002](002-toolclient-interface-as-the-integration-boundary.md) | `ToolClient` interface as the integration boundary | `src/tools/client.ts` |
| [003](003-single-process-shim-with-per-instance-client-cache.md) | Single-process shim with per-instance client cache | `src/index.ts` |
| [004](004-introspect-and-call-as-the-escape-hatch.md) | `openclaw_introspect` + `openclaw_call` as the escape hatch | `src/tools/introspect.ts` |
| [005](005-http-streamable-transport.md) | Streamable HTTP transport | `src/index.ts` |
| [006](006-env-file-secrets-no-keychain.md) | File-based secrets (`.env` + `store.json`), no OS keychain | `src/gateway/env-file.ts` |

## Why these files

`codegraph-toolkit` flagged the first four as **articulation points** in the dependency
graph — files where a bug or breaking change cascades to multiple downstream
files. Articulation points without a documented rationale are a tech-debt
signal. Each ADR explains the trade-off explicitly so future contributors
(human or LLM) can decide whether to reuse, replace, or extend the pattern.

## Adding a new ADR

1. Copy `_TEMPLATE.md` → `NNN-slug.md` (next free number).
2. Fill in the four sections.
3. Anchor it in the affected source file with a top-of-file
   `// ADR-NNN — short title` comment.
4. Add a row to the index above.
5. Commit alongside the code change that motivates it.
