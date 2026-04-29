/** Formats a millisecond duration into a short human-readable string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** Formats "<duration> ago" given a past epoch-ms timestamp. */
export function formatAgo(ms: number | null | undefined, now = Date.now()): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const delta = now - ms;
  if (delta < 0) return "in the future";
  return `${formatDuration(delta)} ago`;
}

/** Truncates a string to `max` chars, adding an ellipsis when truncated. */
export function truncate(s: unknown, max = 200): { value: string; truncated: boolean } {
  if (typeof s !== "string") return { value: String(s ?? ""), truncated: false };
  if (s.length <= max) return { value: s, truncated: false };
  return { value: `${s.slice(0, max)}…`, truncated: true };
}
