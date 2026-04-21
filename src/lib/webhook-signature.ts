// Standard Webhooks HMAC signature verification for Composio deliveries.
//
// Pure function (no DB, no env-cache dependency): accepts raw body + headers +
// the two possible secrets, returns a discriminated result. Called by the
// webhook ingress route (src/app/api/webhooks/composio/route.ts) as the sole
// signature-verification path. Never reads unsigned body fields directly —
// tenant + trigger routing is extracted from signed metadata here and passed
// back to the caller.

import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

export const REPLAY_WINDOW_SECONDS = 300;

export type SignatureFailReason =
  | "missing_headers"
  | "timestamp_out_of_window"
  | "signature_mismatch"
  | "bad_header_format"
  | "bad_body"
  | "missing_metadata"
  | "no_secret_configured";

export interface SignatureSuccess {
  ok: true;
  eventId: string;
  tenantId: string;
  triggerId: string;
  body: unknown;
}

export interface SignatureFailure {
  ok: false;
  reason: SignatureFailReason;
}

export type SignatureResult = SignatureSuccess | SignatureFailure;

/**
 * Case-insensitive header lookup for both plain objects and Headers instances.
 */
function readHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0] ?? null;
      return (v as string | undefined) ?? null;
    }
  }
  return null;
}

/**
 * Constant-time comparison of two base64 strings. Length mismatch rejects
 * without throwing (different-length Buffers would crash nodeTimingSafeEqual).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return nodeTimingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Verify a Composio webhook POST. Pure function: all secrets and the "now"
 * timestamp can be injected for tests.
 *
 * Standard Webhooks signed string: `${webhookId}.${webhookTimestamp}.${rawBody}`.
 * Header may contain multiple space-separated `v1,<base64>` alternatives during
 * rotation on the sender side.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  opts: {
    secret?: string | null;
    previousSecret?: string | null;
    nowSeconds?: number;
  } = {},
): SignatureResult {
  const secret = opts.secret ?? null;
  const previousSecret = opts.previousSecret ?? null;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!secret && !previousSecret) {
    return { ok: false, reason: "no_secret_configured" };
  }

  const webhookId = readHeader(headers, "webhook-id");
  const webhookTimestamp = readHeader(headers, "webhook-timestamp");
  const webhookSignature = readHeader(headers, "webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestamp = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "bad_header_format" };
  }
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  // Build the candidate HMACs we accept — current secret + previous secret
  // during rotation.
  const expected: string[] = [];
  if (secret) expected.push(computeHmacBase64(signedContent, secret));
  if (previousSecret) expected.push(computeHmacBase64(signedContent, previousSecret));

  // Header is like `v1,<base64> v1,<base64_prev>` — iterate every entry.
  const candidateSignatures = webhookSignature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const commaIdx = entry.indexOf(",");
      if (commaIdx <= 0) return null;
      const version = entry.slice(0, commaIdx);
      const value = entry.slice(commaIdx + 1);
      if (version !== "v1") return null;
      return value;
    })
    .filter((v): v is string => v !== null);

  if (candidateSignatures.length === 0) {
    return { ok: false, reason: "bad_header_format" };
  }

  // O(n*m) constant-time comparisons — both sides are tiny (typically 1×1 or
  // 2×2), so there's no timing signal worth caring about.
  const matched = candidateSignatures.some((cand) =>
    expected.some((exp) => constantTimeEqual(cand, exp)),
  );

  if (!matched) {
    return { ok: false, reason: "signature_mismatch" };
  }

  // At this point the body is authenticated; extract signed metadata.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "bad_body" };
  }

  const meta = extractMetadata(parsed);
  if (!meta) {
    return { ok: false, reason: "missing_metadata" };
  }

  return {
    ok: true,
    eventId: meta.eventId,
    tenantId: meta.tenantId,
    triggerId: meta.triggerId,
    body: parsed,
  };
}

function computeHmacBase64(signedContent: string, secret: string): string {
  // Composio sends the secret as a base64-padded key per Standard Webhooks.
  // If the secret starts with `whsec_`, strip the prefix and treat the
  // remainder as base64; otherwise treat as raw utf8 bytes.
  let keyBytes: Buffer;
  if (secret.startsWith("whsec_")) {
    keyBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  } else {
    keyBytes = Buffer.from(secret, "utf8");
  }
  return createHmac("sha256", keyBytes).update(signedContent, "utf8").digest("base64");
}

interface ExtractedMetadata {
  eventId: string;
  tenantId: string;
  triggerId: string;
}

/**
 * Pull the three signed-routing fields out of the authenticated body. Composio
 * v2/v3 payloads put them under `metadata`; v1 uses flatter keys. We only route
 * off fields the signature already covered.
 */
function extractMetadata(body: unknown): ExtractedMetadata | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const metadata = (root.metadata ?? {}) as Record<string, unknown>;

  const eventId =
    pickString(metadata.id)
    ?? pickString(root.id)
    ?? pickString(metadata.event_id)
    ?? pickString(root.event_id);
  const tenantId =
    pickString(metadata.user_id)
    ?? pickString(metadata.userId)
    ?? pickString(root.user_id);
  const triggerId =
    pickString(metadata.trigger_id)
    ?? pickString(metadata.triggerId)
    ?? pickString(root.trigger_id);

  if (!eventId || !tenantId || !triggerId) return null;
  return { eventId, tenantId, triggerId };
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Convenience wrapper that pulls the current + previous secrets from env.
 * Route handlers should prefer this over calling verifyWebhookSignature
 * directly so rotation is one-place-to-change.
 */
export function verifyComposioWebhook(
  rawBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
): SignatureResult {
  const env = getEnv();
  return verifyWebhookSignature(rawBody, headers, {
    secret: env.COMPOSIO_WEBHOOK_SECRET ?? null,
    previousSecret: env.COMPOSIO_WEBHOOK_SECRET_PREVIOUS ?? null,
  });
}
