import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { buildSigningString, generateDevice, signConnect, verifyDeviceId } from "../src/gateway/device.js";

const SAMPLE_INPUT = {
  deviceId: "deadbeef".repeat(8),
  clientId: "openclaw-ios",
  clientMode: "ui",
  role: "operator",
  scopes: ["operator.read", "operator.write"],
  signedAtMs: 1_700_000_000_000,
  token: "tok_abc",
  nonce: "nonce-xyz",
};

function fromBase64Url(s: string): Uint8Array {
  const norm = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return new Uint8Array(Buffer.from(pad, "base64"));
}

describe("buildSigningString", () => {
  it("joins fields with | in a stable order", () => {
    const expected = [
      "v2",
      SAMPLE_INPUT.deviceId,
      "openclaw-ios",
      "ui",
      "operator",
      "operator.read,operator.write",
      "1700000000000",
      "tok_abc",
      "nonce-xyz",
    ].join("|");
    expect(buildSigningString(SAMPLE_INPUT)).toBe(expected);
  });

  it("emits empty string when token is null", () => {
    const s = buildSigningString({ ...SAMPLE_INPUT, token: null });
    expect(s.split("|")[7]).toBe("");
  });
});

describe("generateDevice", () => {
  it("returns a valid Ed25519 keypair with deviceId = sha256(publicKey)", async () => {
    const d = await generateDevice();
    expect(d.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(d.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(d.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);

    // verifyDeviceId reconstructs the id from the public key — ours should match.
    const v = await verifyDeviceId(d);
    expect(v.deviceId).toBe(d.deviceId);
  });

  it("generates fresh keys each call", async () => {
    const a = await generateDevice();
    const b = await generateDevice();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});

describe("signConnect", () => {
  it("produces a signature that verifies against the public key", async () => {
    const device = await generateDevice();
    const sig = await signConnect({ ...SAMPLE_INPUT, deviceId: device.deviceId }, device.privateKey);

    const message = new TextEncoder().encode(buildSigningString({ ...SAMPLE_INPUT, deviceId: device.deviceId }));
    const ok = await ed.verifyAsync(fromBase64Url(sig), message, fromBase64Url(device.publicKey));
    expect(ok).toBe(true);
  });

  it("a tampered message fails verification", async () => {
    const device = await generateDevice();
    const sig = await signConnect({ ...SAMPLE_INPUT, deviceId: device.deviceId }, device.privateKey);

    const tampered = new TextEncoder().encode(
      buildSigningString({ ...SAMPLE_INPUT, deviceId: device.deviceId, nonce: "not-the-original" }),
    );
    const ok = await ed.verifyAsync(fromBase64Url(sig), tampered, fromBase64Url(device.publicKey));
    expect(ok).toBe(false);
  });
});
