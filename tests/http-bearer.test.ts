import { describe, expect, it } from "vitest";
import { checkBearer } from "../src/index.js";

describe("checkBearer", () => {
  const expected = "supersecret-1234567890abcdef";

  it("rejects undefined header", () => {
    expect(checkBearer(expected, undefined)).toBe(false);
  });

  it("rejects empty string header", () => {
    expect(checkBearer(expected, "")).toBe(false);
  });

  it("rejects header without Bearer prefix", () => {
    expect(checkBearer(expected, expected)).toBe(false);
    expect(checkBearer(expected, `Basic ${expected}`)).toBe(false);
    expect(checkBearer(expected, `bearer ${expected}`)).toBe(false);
  });

  it("rejects wrong token of same length", () => {
    const sameLen = "a".repeat(expected.length);
    expect(checkBearer(expected, `Bearer ${sameLen}`)).toBe(false);
  });

  it("rejects wrong token of different length", () => {
    expect(checkBearer(expected, "Bearer short")).toBe(false);
    expect(checkBearer(expected, `Bearer ${expected}extra`)).toBe(false);
  });

  it("rejects empty token after Bearer prefix", () => {
    expect(checkBearer(expected, "Bearer ")).toBe(false);
  });

  it("accepts the exact expected token", () => {
    expect(checkBearer(expected, `Bearer ${expected}`)).toBe(true);
  });

  it("is case-sensitive on the token", () => {
    expect(checkBearer(expected, `Bearer ${expected.toUpperCase()}`)).toBe(false);
  });
});
