// Composio webhook ingress endpoint.
//
// External-origin route; no Bearer auth. Signature verification inside the
// route is the sole auth gate. Middleware bypass is added in src/middleware.ts
// via a narrow regex matching this exact path (not a /api/webhooks/ prefix).
//
// Flow (see plan Unit 6):
//   1. Body-size cap (256 KB) → 413
//   2. Pre-auth rate limit by IP (coarse) → 429
//   3. HMAC signature verification (env secrets) → 401 on failure (log-only)
//   4. Trigger lookup + cross-tenant routing guard → 401
//   5. Post-auth rate limit per tenant → 429 + persisted delivery
//   6. Dedup INSERT webhook_deliveries (ON CONFLICT DO NOTHING) → 200 replay
//   7. Trigger disabled guard → trigger_disabled + 200
//   8. Filter predicate evaluation → filtered + 200
//   9. Prompt render (nonce-delimited)
//  10. createRun → BudgetExceededError (200 budget_blocked) /
//                  ConcurrencyLimitError (429 rejected_429)
//  11. Dispatch run in background → delivery=accepted + 200
//
// Every delivery row transitions from 'received' to exactly one terminal status.

import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { queryOne, withTenantTransaction } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyComposioWebhook } from "@/lib/webhook-signature";
import {
  getTriggerByComposioId,
  encryptDeliveryPayload,
} from "@/lib/webhook-triggers";
import { renderWebhookPrompt, generateNonce } from "@/lib/webhook-prompt";
import { createRun } from "@/lib/runs";
import { executeRunInBackground } from "@/lib/run-executor";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  BudgetExceededError,
  ConcurrencyLimitError,
} from "@/lib/errors";
import { AgentRowInternal } from "@/lib/validation";
import type {
  AgentId,
  RunId,
  TenantId,
  WebhookTriggerId,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// --- Constants ---

// Body-size cap — reject oversized deliveries before touching crypto. 256 KB
// comfortably covers any real Composio payload while limiting resource waste
// on an attacker spewing megabytes.
const MAX_BODY_BYTES = 256 * 1024;

// Pre-auth rate limit: coarse per-IP bucket. Sized to absorb bursts from a
// single Composio egress region without hitting well-meaning tenants.
const PRE_AUTH_RATE_LIMIT = 600;
const PRE_AUTH_WINDOW_MS = 60_000;

// Post-auth rate limit: per-tenant. Tighter; deliveries refused here are
// persisted for audit so the operator can see a sustained source is being
// throttled.
const POST_AUTH_RATE_LIMIT = 300;
const POST_AUTH_WINDOW_MS = 60_000;

// Payload snapshot cap before encryption. Matches migration 029's payload_truncated
// column documentation.
const PAYLOAD_SNAPSHOT_MAX_BYTES = 16_384;

// --- Helpers ---

/**
 * Extract client IP for the pre-auth bucket. Vercel sets `request.ip` from
 * trusted proxy metadata; fall back to the leftmost `x-forwarded-for` entry
 * only when that platform-set field exists. Never parse `x-forwarded-for`
 * from an untrusted edge without a platform signal — a spoof-rotating
 * attacker would otherwise sidestep the bucket by cycling headers.
 */
function extractClientIp(request: NextRequest): string {
  // Next.js NextRequest exposes `ip` only on platforms that set it (e.g. Vercel).
  // On other runtimes (local dev, some bundlers), request.ip is undefined and we
  // fall back to a coarse "unknown" bucket rather than trusting raw headers.
  const maybeIp = (request as unknown as { ip?: string }).ip;
  if (typeof maybeIp === "string" && maybeIp.length > 0) return maybeIp;
  // Platform didn't set request.ip — check if a platform proxy set x-real-ip;
  // if not, use "unknown" so untrusted forwarded-for is never the decision source.
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function truncatedBodyHash(rawBody: string): string {
  // Short hex prefix for log correlation only — not a cryptographic identifier.
  return createHash("sha256").update(rawBody).digest("hex").slice(0, 16);
}

/**
 * Simple dot-path predicate matcher for R5a. Predicate is a flat object keyed
 * by dot-path; values are compared with `===`. Returns true if every entry
 * matches. Null/empty predicates return true (no filter).
 *
 * Kept intentionally minimal — anything more complex (OR, regex, not-equals)
 * belongs in a typed DSL added later, not open-ended here.
 */
export function matchesFilter(
  body: unknown,
  predicate: Record<string, unknown> | null,
): boolean {
  if (!predicate) return true;
  const keys = Object.keys(predicate);
  if (keys.length === 0) return true;
  for (const path of keys) {
    const expected = predicate[path];
    const actual = resolvePath(body, path);
    if (actual !== expected) return false;
  }
  return true;
}

function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split(".").map((s) => s.trim()).filter(Boolean);
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

interface PayloadSnapshot {
  encrypted: { version: number; iv: string; ciphertext: string };
  truncated: boolean;
}

async function buildPayloadSnapshot(
  parsedBody: unknown,
  encryptionKey: string,
): Promise<PayloadSnapshot> {
  const full = JSON.stringify(parsedBody ?? null);
  const truncated = full.length > PAYLOAD_SNAPSHOT_MAX_BYTES;
  const sliced = truncated ? full.slice(0, PAYLOAD_SNAPSHOT_MAX_BYTES) : full;
  const encrypted = await encryptDeliveryPayload(sliced, encryptionKey);
  return { encrypted, truncated };
}

/**
 * Insert a 'received' delivery row with ON CONFLICT DO NOTHING. Returns the
 * newly-inserted row id, or null on dedup hit (replay). Uses a tenant-scoped
 * transaction so RLS on webhook_deliveries is satisfied.
 */
async function insertDelivery(
  tenantId: TenantId,
  triggerId: WebhookTriggerId,
  eventId: string,
  snapshot: PayloadSnapshot,
): Promise<string | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const result = await tx.execute(
      `INSERT INTO webhook_deliveries
         (tenant_id, webhook_trigger_id, composio_event_id, status, payload_snapshot, payload_truncated)
       VALUES ($1, $2, $3, 'received', $4::jsonb, $5)
       ON CONFLICT (composio_event_id) DO NOTHING`,
      [
        tenantId,
        triggerId,
        eventId,
        JSON.stringify(snapshot.encrypted),
        snapshot.truncated,
      ],
    );
    if (result.rowCount === 0) return null;
    // Fetch the row id for subsequent UPDATEs. The unique index on
    // composio_event_id lets us look it up directly.
    const idRow = await tx.queryOne(
      z.object({ id: z.string() }),
      "SELECT id FROM webhook_deliveries WHERE composio_event_id = $1",
      [eventId],
    );
    return idRow?.id ?? null;
  });
}

/**
 * Persist a delivery row for a post-auth rate-limit rejection. Creates a new
 * row with status='rejected_429' directly (no 'received' intermediate) so the
 * audit log captures the rejection. A conflicting event id means the rejection
 * is already represented by a prior row — swallow silently.
 */
async function persistRateLimitedDelivery(
  tenantId: TenantId,
  triggerId: WebhookTriggerId,
  eventId: string,
  snapshot: PayloadSnapshot,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      `INSERT INTO webhook_deliveries
         (tenant_id, webhook_trigger_id, composio_event_id, status, payload_snapshot, payload_truncated)
       VALUES ($1, $2, $3, 'rejected_429', $4::jsonb, $5)
       ON CONFLICT (composio_event_id) DO NOTHING`,
      [
        tenantId,
        triggerId,
        eventId,
        JSON.stringify(snapshot.encrypted),
        snapshot.truncated,
      ],
    );
  });
}

/**
 * UPDATE an existing delivery row to a terminal status. Guarded by tenant_id
 * for defense-in-depth (RLS is authoritative).
 */
async function setDeliveryStatus(
  tenantId: TenantId,
  deliveryId: string,
  status: string,
  runId: string | null = null,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      `UPDATE webhook_deliveries
       SET status = $1, run_id = $2, updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [status, runId, deliveryId, tenantId],
    );
  });
}

// --- Route handler ---

export const POST = withErrorHandler(async (request: NextRequest) => {
  const receivedAt = new Date().toISOString();

  // 1. Pre-auth IP rate limit. Coarse; unrelated to tenant scope.
  const clientIp = extractClientIp(request);
  const ipLimit = checkRateLimit(
    `webhook-ip:${clientIp}`,
    PRE_AUTH_RATE_LIMIT,
    PRE_AUTH_WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    logger.warn("webhook: pre-auth IP rate limit", {
      client_ip: clientIp,
      received_at: receivedAt,
    });
    return jsonResponse(
      { error: { code: "rate_limited", message: "Too many requests" } },
      429,
    );
  }

  // 2. Read raw body (NOT .json() — HMAC needs exact bytes).
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    logger.warn("webhook: body too large", {
      received_at: receivedAt,
      size_bytes: rawBody.length,
      webhook_id_header: request.headers.get("webhook-id"),
    });
    return jsonResponse(
      { error: { code: "payload_too_large", message: "Body exceeds 256KB" } },
      413,
    );
  }

  // 3. Verify HMAC signature. On failure: log-only, no DB write.
  const sig = verifyComposioWebhook(rawBody, request.headers);
  if (!sig.ok) {
    logger.warn("webhook: signature verification failed", {
      reason: sig.reason,
      received_at: receivedAt,
      webhook_id_header: request.headers.get("webhook-id"),
      body_hash_prefix: truncatedBodyHash(rawBody),
    });
    return jsonResponse(
      { error: { code: "unauthorized", message: "Invalid webhook signature" } },
      401,
    );
  }

  const { eventId, tenantId: claimedTenantId, triggerId, body: parsedBody } = sig;

  // 4. Lookup trigger + enforce cross-tenant routing guard.
  //    The signed metadata carries Composio's trigger id (e.g. 'ti_xxx'),
  //    NOT our internal UUID — look up by composio_trigger_id accordingly.
  const trigger = await getTriggerByComposioId(triggerId);
  if (!trigger) {
    logger.warn("webhook: trigger not found", {
      received_at: receivedAt,
      trigger_id: triggerId,
      webhook_id_header: request.headers.get("webhook-id"),
    });
    return jsonResponse(
      { error: { code: "unauthorized", message: "Unknown trigger" } },
      401,
    );
  }
  if (trigger.tenant_id !== claimedTenantId) {
    logger.warn("webhook: cross-tenant routing mismatch", {
      received_at: receivedAt,
      trigger_id: triggerId,
      claimed_tenant_id: claimedTenantId,
      actual_tenant_id: trigger.tenant_id,
    });
    return jsonResponse(
      { error: { code: "unauthorized", message: "Tenant mismatch" } },
      401,
    );
  }

  const tenantId = trigger.tenant_id as TenantId;
  const agentId = trigger.agent_id as AgentId;
  const env = getEnv();

  // Build the payload snapshot once — used both for successful deliveries and
  // for rate-limited-delivery rows.
  const snapshot = await buildPayloadSnapshot(parsedBody, env.ENCRYPTION_KEY);

  // 5. Post-auth per-tenant rate limit. Exceeded → persisted + 429.
  const tenantLimit = checkRateLimit(
    `webhook:${tenantId}`,
    POST_AUTH_RATE_LIMIT,
    POST_AUTH_WINDOW_MS,
  );
  if (!tenantLimit.allowed) {
    await persistRateLimitedDelivery(
      tenantId,
      trigger.id as WebhookTriggerId,
      eventId,
      snapshot,
    ).catch((err) => {
      logger.error("webhook: failed to persist rate-limited delivery", {
        tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return jsonResponse(
      { error: { code: "rate_limited", message: "Tenant rate limit exceeded" } },
      429,
    );
  }

  // 6. Dedup INSERT. If no row returned, this is a replay — 200 immediately.
  const deliveryId = await insertDelivery(
    tenantId,
    trigger.id as WebhookTriggerId,
    eventId,
    snapshot,
  );
  if (!deliveryId) {
    logger.info("webhook: replay suppressed", { tenant_id: tenantId, event_id: eventId });
    return jsonResponse({ status: "replay" });
  }

  // 7. Trigger-disabled short-circuit.
  if (!trigger.enabled) {
    await setDeliveryStatus(tenantId, deliveryId, "trigger_disabled");
    return jsonResponse({ status: "trigger_disabled" });
  }

  // 8. Filter predicate evaluation.
  if (!matchesFilter(parsedBody, trigger.filter_predicate)) {
    await setDeliveryStatus(tenantId, deliveryId, "filtered");
    return jsonResponse({ status: "filtered" });
  }

  // 9. Render prompt with per-delivery nonce (injection defense).
  const nonce = generateNonce();
  const { prompt, systemPromptAddendum } = renderWebhookPrompt({
    template: trigger.prompt_template,
    payload: parsedBody,
    nonce,
  });

  // 10. Create the run. Map known errors to the appropriate terminal status
  //     + HTTP code; every error branch persists exactly one delivery update.
  let runId: RunId;
  let remainingBudget: number;
  try {
    const result = await createRun(tenantId, agentId, prompt, {
      triggeredBy: "webhook",
    });
    runId = result.run.id as RunId;
    remainingBudget = result.remainingBudget;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await setDeliveryStatus(tenantId, deliveryId, "budget_blocked");
      return jsonResponse({ status: "budget_blocked" });
    }
    if (err instanceof ConcurrencyLimitError) {
      await setDeliveryStatus(tenantId, deliveryId, "rejected_429");
      return jsonResponse(
        { error: { code: "concurrency_limit", message: "Too many concurrent runs" } },
        429,
      );
    }
    await setDeliveryStatus(tenantId, deliveryId, "run_failed_to_create");
    logger.error("webhook: unexpected createRun failure", {
      tenant_id: tenantId,
      trigger_id: triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // 11. Load the agent row (needed by prepareRunExecution) and dispatch in
  //     background. Do NOT block the 200 response on sandbox startup.
  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, tenantId],
  );
  if (!agent) {
    // Extremely unlikely (trigger FK requires agent), but handle gracefully.
    await setDeliveryStatus(tenantId, deliveryId, "run_failed_to_create");
    return jsonResponse(
      { error: { code: "internal_error", message: "Agent missing" } },
      500,
    );
  }

  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);
  const effectiveMaxTurns = agent.max_turns;
  const maxRuntimeSeconds = agent.max_runtime_seconds;

  // Background dispatch — fire-and-forget. Any failure here marks the delivery
  // as run_failed_to_create so the audit log reflects the truth even though
  // the HTTP response already went out.
  void executeRunInBackground({
    agent,
    tenantId,
    runId,
    prompt,
    platformApiUrl: getCallbackBaseUrl(),
    effectiveBudget,
    effectiveMaxTurns,
    maxRuntimeSeconds,
    toolAllowlist: trigger.tool_allowlist,
    systemPromptAddendum,
  }).catch((err) => {
    logger.error("webhook: background run execution failed", {
      run_id: runId,
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    setDeliveryStatus(tenantId, deliveryId, "run_failed_to_create").catch(
      (updErr) => {
        logger.error("webhook: failed to mark delivery run_failed_to_create", {
          delivery_id: deliveryId,
          error: updErr instanceof Error ? updErr.message : String(updErr),
        });
      },
    );
  });

  await setDeliveryStatus(tenantId, deliveryId, "accepted", runId);

  return jsonResponse({ status: "accepted", run_id: runId });
});
