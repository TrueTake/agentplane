import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  base64UrlEncode,
  base64UrlDecode,
  signState,
  verifyState,
} from "@/lib/hmac-state";
import { resetEnvCache } from "@/lib/env";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  ENCRYPTION_KEY: "a".repeat(64),
  ADMIN_API_KEY: "admin-key-123",
  AI_GATEWAY_API_KEY: "gateway-key-456",
  CRON_SECRET: "test-cron-secret",
  NODE_ENV: "test",
};

describe("base64UrlEncode / base64UrlDecode", () => {
  it("round-trips binary data", () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it("produces URL-safe output (no +, /, =)", () => {
    // Use data that would normally produce +, /, or = in standard base64
    const data = new Uint8Array([251, 239, 190, 251, 239, 190]);
    const encoded = base64UrlEncode(data);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("round-trips empty data", () => {
    const original = new Uint8Array([]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles ArrayBuffer input", () => {
    const original = new Uint8Array([10, 20, 30]);
    const encoded = base64UrlEncode(original.buffer as ArrayBuffer);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(original);
  });
});

describe("signState / verifyState", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    resetEnvCache();
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("sign and verify round-trip with arbitrary payload", async () => {
    const payload = { foo: "bar", num: 42, nested: { a: 1 } };
    const state = await signState(payload);
    const result = await verifyState(state);

    expect(result).not.toBeNull();
    expect(result!.foo).toBe("bar");
    expect(result!.num).toBe(42);
    expect(result!.nested).toEqual({ a: 1 });
    expect(typeof result!.exp).toBe("number");
  });

  it("produces URL-safe tokens", async () => {
    const state = await signState({ test: true });
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects tampered payload", async () => {
    const state = await signState({ secret: "value" });
    const tampered = (state[0] === "A" ? "B" : "A") + state.slice(1);
    const result = await verifyState(tampered);
    expect(result).toBeNull();
  });

  it("rejects tampered signature", async () => {
    const state = await signState({ secret: "value" });
    const [payload, sig] = state.split(".");
    const tampered = `${payload}.${sig![0] === "A" ? "B" : "A"}${sig!.slice(1)}`;
    const result = await verifyState(tampered);
    expect(result).toBeNull();
  });

  it("rejects expired state", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now - 20 * 60 * 1000) // sign: 20 min ago
      .mockReturnValue(now); // verify: now

    const state = await signState({ test: true });
    const result = await verifyState(state);
    expect(result).toBeNull();
  });

  it("rejects empty string", async () => {
    const result = await verifyState("");
    expect(result).toBeNull();
  });

  it("rejects state without dot separator", async () => {
    const result = await verifyState("nodothere");
    expect(result).toBeNull();
  });

  it("rejects completely invalid base64", async () => {
    const result = await verifyState("!!!.!!!");
    expect(result).toBeNull();
  });

  it("different payloads produce different tokens", async () => {
    const state1 = await signState({ a: 1 });
    const state2 = await signState({ a: 2 });
    expect(state1).not.toBe(state2);
  });
});
