import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRun } from "@/lib/runs";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ConcurrencyLimitError, BudgetExceededError } from "@/lib/errors";
import {
  UpdateWebhookSourceSchema,
  attachDeliveryRun,
  buildPromptFromTemplate,
  deleteWebhookSource,
  getWebhookSource,
  loadWebhookSource,
  recordDelivery,
  touchSourceLastTriggered,
  updateWebhookSource,
  verifyAndPrepare,
  type DeliveryError,
} from "@/lib/webhooks";
import type {
  AgentId,
  RunId,
  TenantId,
  WebhookSourceId,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 512 * 1024;
const RATE_WINDOW_MS = 60_000;
const PER_SOURCE_LIMIT = 60;
const PER_TENANT_LIMIT = 600;

const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_DELIVERY_ID = "webhook-delivery-id";

function genericUnauthorized(): NextResponse {
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Unauthorized" } },
    { status: 401 },
  );
}

async function readLimitedBody(req: NextRequest, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function markDeliveryError(deliveryRowId: string, error: DeliveryError): Promise<void> {
  await execute(
    `UPDATE webhook_deliveries SET valid = false, error = $1 WHERE id = $2`,
    [error, deliveryRowId],
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sourceId: string }> },
): Promise<NextResponse> {
  const { sourceId } = await context.params;

  const sourceLimit = checkRateLimit(`webhook:source:${sourceId}`, PER_SOURCE_LIMIT, RATE_WINDOW_MS);
  if (!sourceLimit.allowed) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(Math.ceil(sourceLimit.retryAfterMs / 1000)) } },
    );
  }

  const source = await loadWebhookSource(sourceId as WebhookSourceId);
  if (!source || !source.enabled) {
    return genericUnauthorized();
  }

  const tenantLimit = checkRateLimit(
    `webhook:tenant:${source.tenant_id}`,
    PER_TENANT_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!tenantLimit.allowed) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(Math.ceil(tenantLimit.retryAfterMs / 1000)) } },
    );
  }

  const deliveryId = request.headers.get(HEADER_DELIVERY_ID);
  if (!deliveryId) {
    return NextResponse.json(
      { error: { code: "missing_delivery_id", message: `Missing ${HEADER_DELIVERY_ID} header` } },
      { status: 400 },
    );
  }

  const sigHeaderName = source.signature_header.toLowerCase();
  const signature = request.headers.get(sigHeaderName);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);

  const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return NextResponse.json(
      { error: { code: "payload_too_large", message: "Body exceeds 512KB" } },
      { status: 413 },
    );
  }

  const payloadHash = await sha256Hex(rawBody);

  const verifyResult = await verifyAndPrepare(source, signature, timestamp, rawBody);
  if (!verifyResult.ok) {
    await recordDelivery({
      tenantId: source.tenant_id as TenantId,
      sourceId: source.id as WebhookSourceId,
      deliveryId,
      payloadHash,
      valid: false,
      error: verifyResult.error,
      runId: null,
    });
    return genericUnauthorized();
  }

  let payload: unknown;
  try {
    payload = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch {
    await recordDelivery({
      tenantId: source.tenant_id as TenantId,
      sourceId: source.id as WebhookSourceId,
      deliveryId,
      payloadHash,
      valid: false,
      error: "invalid_json",
      runId: null,
    });
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }

  const initialDelivery = await recordDelivery({
    tenantId: source.tenant_id as TenantId,
    sourceId: source.id as WebhookSourceId,
    deliveryId,
    payloadHash,
    valid: true,
    error: null,
    runId: null,
  });

  if (initialDelivery.kind === "duplicate") {
    return NextResponse.json(
      {
        run_id: initialDelivery.existingRunId,
        duplicate: true,
        status_url: initialDelivery.existingRunId ? `/api/runs/${initialDelivery.existingRunId}` : null,
      },
      { status: 200 },
    );
  }

  const prompt = buildPromptFromTemplate(source.prompt_template, payload, { name: source.name });

  let runId: RunId;
  try {
    const created = await createRun(
      source.tenant_id as TenantId,
      source.agent_id as AgentId,
      prompt,
      {
        triggeredBy: "webhook",
        webhookSourceId: source.id as WebhookSourceId,
      },
    );
    runId = created.run.id as RunId;
  } catch (err) {
    let code: DeliveryError = "internal_error";
    let status = 500;
    if (err instanceof ConcurrencyLimitError) {
      code = "rate_limited";
      status = 429;
    } else if (err instanceof BudgetExceededError) {
      code = "internal_error";
      status = 402;
    }
    await markDeliveryError(initialDelivery.deliveryRowId, code);
    logger.warn("webhook run creation failed", {
      source_id: source.id,
      delivery_id: deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: { code, message: err instanceof Error ? err.message : "Internal error" } },
      { status },
    );
  }

  await Promise.all([
    attachDeliveryRun(initialDelivery.deliveryRowId, runId),
    touchSourceLastTriggered(source.id as WebhookSourceId),
  ]).catch((err) => {
    logger.warn("webhook post-create attach failed", {
      source_id: source.id,
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json(
    {
      run_id: runId,
      duplicate: false,
      status_url: `/api/runs/${runId}`,
      source_name: source.name,
    },
    { status: 202 },
  );
}

// ─── Tenant CRUD (auth required) ──────────────────────────────────────────────
//
// Co-located with the public ingress POST above. The `sourceId` URL segment is
// the same identifier in both flows; auth is enforced per-method.

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const source = await getWebhookSource(auth.tenantId, sourceId as WebhookSourceId);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const body = await request.json();
  const patch = UpdateWebhookSourceSchema.parse(body);
  const source = await updateWebhookSource(auth.tenantId, sourceId as WebhookSourceId, patch);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;
  const removed = await deleteWebhookSource(auth.tenantId, sourceId as WebhookSourceId);
  if (!removed) throw new NotFoundError("Webhook source not found");
  return jsonResponse({ deleted: true });
});
