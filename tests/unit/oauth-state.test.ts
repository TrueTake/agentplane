import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signOAuthState, verifyOAuthState } from "@/lib/oauth-state";
import { resetEnvCache } from "@/lib/env";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  ENCRYPTION_KEY: "a".repeat(64),
  ADMIN_API_KEY: "admin-key-123",
  AI_GATEWAY_API_KEY: "gateway-key-456",
  CRON_SECRET: "test-cron-secret",
  NODE_ENV: "test",
};

const testPayload = {
  agentId: "agent-1",
  tenantId: "tenant-1",
  toolkit: "github",
};

describe("OAuth State (Composio)", () => {
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

  it("sign and verify round-trip", async () => {
    const state = await signOAuthState(testPayload);
    const result = await verifyOAuthState(state);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
    expect(result!.tenantId).toBe("tenant-1");
    expect(result!.toolkit).toBe("github");
  });

  it("produces URL-safe tokens", async () => {
    const state = await signOAuthState(testPayload);
    expect(state).not.toMatch(/[+/=]/);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects tampered state", async () => {
    const state = await signOAuthState(testPayload);
    const tampered = (state[0] === "A" ? "B" : "A") + state.slice(1);
    const result = await verifyOAuthState(tampered);
    expect(result).toBeNull();
  });

  it("rejects expired state", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now - 20 * 60 * 1000)
      .mockReturnValue(now);

    const state = await signOAuthState(testPayload);
    const result = await verifyOAuthState(state);
    expect(result).toBeNull();
  });

  it("rejects empty string", async () => {
    const result = await verifyOAuthState("");
    expect(result).toBeNull();
  });

  it("preserves all payload fields", async () => {
    const payload = {
      agentId: "ag-complex-id-123",
      tenantId: "tn-456",
      toolkit: "slack",
    };
    const state = await signOAuthState(payload);
    const result = await verifyOAuthState(state);

    expect(result).toEqual(payload);
  });
});
