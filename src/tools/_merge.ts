/**
 * Shared deep-merge / project-by-path helpers used by tools that synthesize
 * `config.patch` payloads (`openclaw_config_patch` convenience flow,
 * `openclaw_secrets_set`). Kept module-scope so the helpers can be unit-
 * tested independently and so adding a new "set this thing in the config
 * tree" tool doesn't require duplicating 30 lines of boilerplate.
 */

export function projectByPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  const segments = path.split(".").filter(Boolean);
  let cursor: unknown = value;
  for (const seg of segments) {
    if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function mergeAt(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return deepMerge(root, value as Record<string, unknown>);
    }
    throw new Error("mergePath empty — pass an object as mergeValue or use a path.");
  }
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const next = cursor[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  const existing = cursor[last];
  if (
    existing && typeof existing === "object" && !Array.isArray(existing) &&
    value && typeof value === "object" && !Array.isArray(value)
  ) {
    cursor[last] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
  } else {
    cursor[last] = value;
  }
  return root;
}

export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (
      cur && typeof cur === "object" && !Array.isArray(cur) &&
      v && typeof v === "object" && !Array.isArray(v)
    ) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
