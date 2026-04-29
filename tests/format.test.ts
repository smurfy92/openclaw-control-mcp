import { describe, expect, it } from "vitest";
import { formatAgo, formatDuration, truncate } from "../src/format.js";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [500, "500ms"],
    [999, "999ms"],
    [1000, "1s"],
    [59_000, "59s"],
    [60_000, "1min"],
    [3_540_000, "59min"],
    [3_600_000, "1h"],
    [86_400_000, "24h"],
    [172_800_000, "2d"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("returns ? for negative or non-finite values", () => {
    expect(formatDuration(-1)).toBe("?");
    expect(formatDuration(Number.NaN)).toBe("?");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("?");
  });
});

describe("formatAgo", () => {
  it("returns null for null/undefined timestamp", () => {
    expect(formatAgo(null)).toBeNull();
    expect(formatAgo(undefined)).toBeNull();
  });

  it("returns 'in the future' when ts > now", () => {
    expect(formatAgo(Date.now() + 60_000)).toBe("in the future");
  });

  it("returns '<duration> ago' for past timestamps", () => {
    const now = 1_700_000_000_000;
    expect(formatAgo(now - 5_000, now)).toBe("5s ago");
    expect(formatAgo(now - 3_600_000, now)).toBe("1h ago");
    expect(formatAgo(now - 86_400_000, now)).toBe("24h ago");
  });
});

describe("truncate", () => {
  it("returns the original string when shorter than max", () => {
    const r = truncate("hello", 200);
    expect(r).toEqual({ value: "hello", truncated: false });
  });

  it("truncates and marks when longer than max", () => {
    const r = truncate("a".repeat(250), 200);
    expect(r.value).toHaveLength(201); // 200 + ellipsis
    expect(r.value.endsWith("…")).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("coerces non-strings to a stringified value", () => {
    expect(truncate(42)).toEqual({ value: "42", truncated: false });
    expect(truncate(null)).toEqual({ value: "", truncated: false });
    expect(truncate(undefined)).toEqual({ value: "", truncated: false });
  });
});
