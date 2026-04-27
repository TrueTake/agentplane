import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebhookSourceRow } from "@/lib/webhooks";

const mocks = vi.hoisted(() => ({
  loadWebhookSource: vi.fn(),
  verifyAndPrepare: vi.fn(),
  recordDelivery: vi.fn(),
  attachDeliveryRun: vi.fn(),
  touchSourceLastTriggered: vi.fn(),
  buildPromptFromTemplate: vi.fn(
    (template: string, payload: unknown, source: { name: string }) =>
      `${template} :: ${source.name} :: ${JSON.stringify(payload)}`,
  ),
  createRun: vi.fn(),
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, retryAfterMs: 0 })),
}));

vi.mock("@/db", () => ({
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/webhooks", () => ({
  loadWebhookSource: mocks.loadWebhookSource,
  verifyAndPrepare: mocks.verifyAndPrepare,
  recordDelivery: mocks.recordDelivery,
  attachDeliveryRun: mocks.attachDeliveryRun,
  touchSourceLastTriggered: mocks.touchSourceLastTriggered,
  buildPromptFromTemplate: mocks.buildPromptFromTemplate,
}));

vi.mock("@/lib/runs", () => ({
  createRun: mocks.createRun,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/webhooks/[sourceId]/route";

const {
  loadWebhookSource,
  verifyAndPrepare,
  recordDelivery,
  attachDeliveryRun,
  touchSourceLastTriggered,
  createRun,
  checkRateLimit,
} = mocks;

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

function source(overrides: Partial<WebhookSourceRow> = {}): WebhookSourceRow {
  return {
    id: SOURCE_ID,
    tenant_id: "22222222-2222-2222-2222-222222222222",
    agent_id: "33333333-3333-3333-3333-333333333333",
    name: "github",
    enabled: true,
    signature_header: "X-AgentPlane-Signature",
    signature_format: "sha256_hex",
    secret_enc: "{}",
    previous_secret_enc: null,
    previous_secret_expires_at: null,
    prompt_template: "Event: {{payload}}",
    last_triggered_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeRequest({
  body = '{"hello":"world"}',
  headers = {},
}: {
  body?: string;
  headers?: Record<string, string>;
} = {}): import("next/server").NextRequest {
  const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      ...headers,
    },
    body,
  });
  return req as unknown as import("next/server").NextRequest;
}

const ctx = { params: Promise.resolve({ sourceId: SOURCE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterMs: 0 });
  loadWebhookSource.mockResolvedValue(source());
  verifyAndPrepare.mockResolvedValue({ ok: true, usedPrevious: false });
  recordDelivery.mockResolvedValue({ kind: "inserted", deliveryRowId: "delivery-row-1" });
  attachDeliveryRun.mockResolvedValue(undefined);
  touchSourceLastTriggered.mockResolvedValue(undefined);
  createRun.mockResolvedValue({
    run: { id: "run-abc-123" },
    agent: {},
    remainingBudget: 100,
  });
});

describe("POST /api/webhooks/[sourceId]", () => {
  it("happy path: valid signed POST returns 202 with run_id", async () => {
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "a".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "delivery-1",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      run_id: "run-abc-123",
      duplicate: false,
      status_url: "/api/runs/run-abc-123",
      source_name: "github",
    });
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(attachDeliveryRun).toHaveBeenCalledWith("delivery-row-1", "run-abc-123");
    expect(touchSourceLastTriggered).toHaveBeenCalled();
  });

  it("returns 400 when Webhook-Delivery-Id header is missing", async () => {
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("missing_delivery_id");
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("returns generic 401 when source is unknown (no delivery row)", async () => {
    loadWebhookSource.mockResolvedValueOnce(null);
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "x",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("returns generic 401 when source is disabled (delivery row recorded)", async () => {
    loadWebhookSource.mockResolvedValueOnce(source({ enabled: false }));
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "x",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("returns 401 and records delivery on bad signature", async () => {
    verifyAndPrepare.mockResolvedValueOnce({ ok: false, error: "signature_mismatch" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "0".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-1",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        valid: false,
        error: "signature_mismatch",
        runId: null,
      }),
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 401 and records delivery on stale timestamp", async () => {
    verifyAndPrepare.mockResolvedValueOnce({ ok: false, error: "stale_timestamp" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "0".repeat(64),
        "webhook-timestamp": "1700000000",
        "webhook-delivery-id": "del-2",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stale_timestamp" }),
    );
  });

  it("returns 413 when Content-Length exceeds 512KB", async () => {
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(513 * 1024),
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "del-3",
      },
      body: "{}",
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req, ctx);
    expect(res.status).toBe(413);
  });

  it("returns 400 and records delivery on invalid JSON body", async () => {
    const req = makeRequest({
      body: "not-json{",
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-4",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ valid: false, error: "invalid_json" }),
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 200 with existing run_id on duplicate delivery_id", async () => {
    recordDelivery.mockResolvedValueOnce({ kind: "duplicate", existingRunId: "run-existing-9" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-5",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ run_id: "run-existing-9", duplicate: true });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 429 when per-source rate limit is exceeded", async () => {
    checkRateLimit.mockReturnValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterMs: 30_000,
    });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "del-6",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(loadWebhookSource).not.toHaveBeenCalled();
  });

  it("rolls delivery row to error on createRun ConcurrencyLimitError (429)", async () => {
    const { ConcurrencyLimitError } = await import("@/lib/errors");
    createRun.mockRejectedValueOnce(new ConcurrencyLimitError("limit"));
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-7",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(429);
    expect(attachDeliveryRun).not.toHaveBeenCalled();
  });
});
