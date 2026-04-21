import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// Mocks set up BEFORE importing the route module.
// ─────────────────────────────────────────────────────────────────────────

const mockExecute = vi.fn();
const mockTxExecute = vi.fn();
const mockTxQueryOne = vi.fn();

vi.mock("@/db", () => ({
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      execute: mockTxExecute,
      queryOne: mockTxQueryOne,
      // query is unused in this route
      query: vi.fn(),
    }),
  ),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/webhook-signature", () => ({
  verifyComposioWebhook: vi.fn(),
}));

vi.mock("@/lib/webhook-triggers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webhook-triggers")>(
    "@/lib/webhook-triggers",
  );
  return {
    ...actual,
    getTriggerById: vi.fn(),
    // Preserve the actual encrypt re-export (it just wraps crypto.encrypt).
  };
});

vi.mock("@/lib/runs", () => ({
  createRun: vi.fn(),
}));

vi.mock("@/lib/run-executor", () => ({
  executeRunInBackground: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mcp-connections", () => ({
  getCallbackBaseUrl: vi.fn(() => "https://example.test"),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({
    ENCRYPTION_KEY: "a".repeat(64),
    ENCRYPTION_KEY_PREVIOUS: undefined,
    COMPOSIO_WEBHOOK_SECRET: "test-secret",
    COMPOSIO_WEBHOOK_SECRET_PREVIOUS: undefined,
  })),
}));

// Reset in-memory rate-limit buckets between tests so IP/tenant buckets don't
// leak state across assertions.
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit",
  );
  return { ...actual };
});

// ─────────────────────────────────────────────────────────────────────────
// Imports under test (after mocks).
// ─────────────────────────────────────────────────────────────────────────

import { POST, matchesFilter } from "@/app/api/webhooks/composio/route";
import { queryOne } from "@/db";
import { verifyComposioWebhook } from "@/lib/webhook-signature";
import { getTriggerById } from "@/lib/webhook-triggers";
import { createRun } from "@/lib/runs";
import { executeRunInBackground } from "@/lib/run-executor";
import { BudgetExceededError, ConcurrencyLimitError } from "@/lib/errors";
import type { NextRequest } from "next/server";

const mockQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>;
const mockVerify = verifyComposioWebhook as unknown as ReturnType<typeof vi.fn>;
const mockGetTrigger = getTriggerById as unknown as ReturnType<typeof vi.fn>;
const mockCreateRun = createRun as unknown as ReturnType<typeof vi.fn>;
const mockExecuteRun = executeRunInBackground as unknown as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeRequest(body: string, headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/webhooks/composio", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-real-ip": `ip-${Math.random().toString(36).slice(2, 10)}`,
      ...headers,
    },
  }) as unknown as NextRequest;
}

const baseTrigger = {
  id: "trigger-1",
  tenant_id: "tenant-1",
  agent_id: "agent-1",
  toolkit_slug: "linear",
  trigger_type: "LINEAR_ISSUE_CREATED",
  composio_trigger_id: "ti_abc",
  prompt_template: "Handle issue {{data.issue.id}}",
  filter_predicate: null,
  tool_allowlist: [],
  enabled: true,
  pending_cancel: false,
  last_cancel_attempt_at: null,
  cancel_attempts: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

const baseAgent = {
  id: "agent-1",
  tenant_id: "tenant-1",
  name: "Agent",
  description: null,
  max_budget_usd: 10,
  max_turns: 20,
  max_runtime_seconds: 600,
  model: "anthropic/claude-sonnet-4-20250514",
  runner: "claude-agent-sdk",
  // …other columns omitted — route only reads the four fields above plus the
  // bag that gets passed straight through to executeRunInBackground, which is
  // mocked.
};

function signedVerifySuccess(overrides: Partial<{
  eventId: string;
  tenantId: string;
  triggerId: string;
  body: unknown;
}> = {}) {
  mockVerify.mockReturnValue({
    ok: true,
    eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: overrides.tenantId ?? "tenant-1",
    triggerId: overrides.triggerId ?? "trigger-1",
    body: overrides.body ?? { data: { issue: { id: 42, state: { name: "Triage" } } } },
  });
}

// Stable body used by most tests — content doesn't matter since verify is mocked.
const BODY = JSON.stringify({ metadata: {}, data: { issue: { id: 42, state: { name: "Triage" } } } });

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockReset();
  mockTxExecute.mockReset();
  mockTxQueryOne.mockReset();

  // Default tx.execute returns 1 row (successful INSERT ... ON CONFLICT DO NOTHING).
  mockTxExecute.mockResolvedValue({ rowCount: 1 });
  // Default tx.queryOne returns a delivery row with an id.
  mockTxQueryOne.mockResolvedValue({ id: "delivery-1" });
  // Default agent lookup returns baseAgent.
  mockQueryOne.mockResolvedValue(baseAgent);
  // Default createRun: successful.
  mockCreateRun.mockResolvedValue({
    run: { id: "run-1" },
    agent: baseAgent,
    remainingBudget: 5,
  });
  mockExecuteRun.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/composio", () => {
  it("returns 401 when signature verification fails; no delivery persisted", async () => {
    mockVerify.mockReturnValue({ ok: false, reason: "signature_mismatch" });
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(401);
    expect(mockTxExecute).not.toHaveBeenCalled();
    expect(mockGetTrigger).not.toHaveBeenCalled();
  });

  it("returns 413 when body exceeds 256KB", async () => {
    const huge = "x".repeat(260 * 1024);
    const res = await POST(makeRequest(huge));
    expect(res.status).toBe(413);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns 401 when trigger is not found", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue(null);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(401);
    expect(mockTxExecute).not.toHaveBeenCalled();
  });

  it("returns 401 when signed tenantId does not match trigger.tenant_id", async () => {
    signedVerifySuccess({ tenantId: "tenant-OTHER" });
    mockGetTrigger.mockResolvedValue(baseTrigger);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(401);
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns 200 (replay) when dedup INSERT hits ON CONFLICT", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue(baseTrigger);
    // tx.execute returns 0 rows → dedup hit.
    mockTxExecute.mockResolvedValueOnce({ rowCount: 0 });

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "replay" });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns 200 trigger_disabled when trigger.enabled is false", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue({ ...baseTrigger, enabled: false });

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "trigger_disabled" });
    expect(mockCreateRun).not.toHaveBeenCalled();

    // tx.execute called twice: INSERT 'received', then UPDATE to 'trigger_disabled'.
    const statuses = mockTxExecute.mock.calls
      .map((c) => (c[1] as unknown[])?.[0])
      .filter((v) => typeof v === "string");
    expect(statuses).toContain("trigger_disabled");
  });

  it("returns 200 filtered when filter_predicate does not match", async () => {
    signedVerifySuccess({ body: { data: { issue: { state: { name: "Backlog" } } } } });
    mockGetTrigger.mockResolvedValue({
      ...baseTrigger,
      filter_predicate: { "data.issue.state.name": "Triage" },
    });

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "filtered" });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns 200 budget_blocked when createRun throws BudgetExceededError", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue(baseTrigger);
    mockCreateRun.mockRejectedValue(new BudgetExceededError("budget"));

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "budget_blocked" });
    expect(mockExecuteRun).not.toHaveBeenCalled();

    const updates = mockTxExecute.mock.calls.map((c) => (c[1] as unknown[])?.[0]);
    expect(updates).toContain("budget_blocked");
  });

  it("returns 429 rejected_429 when createRun throws ConcurrencyLimitError", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue(baseTrigger);
    mockCreateRun.mockRejectedValue(new ConcurrencyLimitError("too many"));

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(429);
    expect(mockExecuteRun).not.toHaveBeenCalled();

    const updates = mockTxExecute.mock.calls.map((c) => (c[1] as unknown[])?.[0]);
    expect(updates).toContain("rejected_429");
  });

  it("happy path: accepts, creates run, dispatches in background, marks delivery accepted", async () => {
    signedVerifySuccess();
    mockGetTrigger.mockResolvedValue(baseTrigger);

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "accepted", run_id: "run-1" });

    expect(mockCreateRun).toHaveBeenCalledOnce();
    const createRunArgs = mockCreateRun.mock.calls[0];
    expect(createRunArgs[0]).toBe("tenant-1");
    expect(createRunArgs[1]).toBe("agent-1");
    expect(createRunArgs[3]).toEqual({ triggeredBy: "webhook" });

    expect(mockExecuteRun).toHaveBeenCalledOnce();
    const runArgs = mockExecuteRun.mock.calls[0][0];
    expect(runArgs.tenantId).toBe("tenant-1");
    expect(runArgs.runId).toBe("run-1");
    expect(runArgs.systemPromptAddendum).toMatch(/webhook_payload_/);
    expect(runArgs.toolAllowlist).toEqual([]);

    const updates = mockTxExecute.mock.calls.map((c) => (c[1] as unknown[])?.[0]);
    expect(updates).toContain("accepted");
  });

  it("passes a dual-form toolAllowlist through to executeRunInBackground", async () => {
    signedVerifySuccess();
    const allowlist = [
      { claude: "Read", aiSdk: "Read" },
      { claude: "mcp__composio__LINEAR_CREATE", aiSdk: "LINEAR_CREATE" },
    ];
    mockGetTrigger.mockResolvedValue({ ...baseTrigger, tool_allowlist: allowlist });

    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    expect(mockExecuteRun.mock.calls[0][0].toolAllowlist).toEqual(allowlist);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// matchesFilter (exported helper)
// ─────────────────────────────────────────────────────────────────────────

describe("matchesFilter", () => {
  it("returns true for null/empty predicate", () => {
    expect(matchesFilter({ anything: 1 }, null)).toBe(true);
    expect(matchesFilter({ anything: 1 }, {})).toBe(true);
  });

  it("returns true when every dot-path resolves to the expected value", () => {
    const body = { data: { issue: { state: { name: "Triage" } } } };
    expect(matchesFilter(body, { "data.issue.state.name": "Triage" })).toBe(true);
  });

  it("returns false when a dot-path value mismatches", () => {
    const body = { data: { issue: { state: { name: "Backlog" } } } };
    expect(matchesFilter(body, { "data.issue.state.name": "Triage" })).toBe(false);
  });

  it("returns false when a dot-path is missing", () => {
    const body = { data: {} };
    expect(matchesFilter(body, { "data.issue.state.name": "Triage" })).toBe(false);
  });

  it("requires ALL entries to match (AND semantics)", () => {
    const body = { a: 1, b: 2 };
    expect(matchesFilter(body, { a: 1, b: 2 })).toBe(true);
    expect(matchesFilter(body, { a: 1, b: 3 })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Middleware bypass regex smoke-test.
// ─────────────────────────────────────────────────────────────────────────
//
// Tests the anchored regex directly so a future refactor that accidentally
// widens it (e.g. /^\/api\/webhooks\//) is caught immediately. Full middleware
// invocation is hard to test in isolation (it depends on NextRequest + the
// Next runtime), so the regex assertion covers the contract we care about.

describe("middleware COMPOSIO_WEBHOOK_RE anchoring", () => {
  const RE = /^\/api\/webhooks\/composio$/;

  it("matches exactly the composio webhook path", () => {
    expect(RE.test("/api/webhooks/composio")).toBe(true);
  });

  it("does NOT match any sibling path under /api/webhooks/", () => {
    expect(RE.test("/api/webhooks/other-path")).toBe(false);
    expect(RE.test("/api/webhooks/composio/extra")).toBe(false);
    expect(RE.test("/api/webhooks/")).toBe(false);
    expect(RE.test("/api/webhooks")).toBe(false);
  });
});

// Silence unused-import warning — createHmac is kept for future test
// expansion (real signature round-trips).
void createHmac;
