import { describe, expect, it } from "vitest";
import { getMcpVersion } from "../src/version.js";

describe("getMcpVersion", () => {
  it("returns a non-empty semver-ish string", () => {
    const v = getMcpVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    // Either a real semver or the fallback "0.0.0-unknown"
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns the same value across calls (cached)", () => {
    expect(getMcpVersion()).toBe(getMcpVersion());
  });
});
