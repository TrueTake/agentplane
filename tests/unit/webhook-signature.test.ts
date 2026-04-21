import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyWebhookSignature, REPLAY_WINDOW_SECONDS } from "@/lib/webhook-signature";

const SECRET = "super-secret-shared-key";
const PREV_SECRET = "previous-shared-key";

function hmacV1(signedContent: string, secret: string): string {
  const sig = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(signedContent, "utf8")
    .digest("base64");
  return `v1,${sig}`;
}

function buildHeaders(id: string, ts: number, signature: string): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signature,
  };
}

function buildBody(overrides: Partial<{
  id: string;
  userId: string;
  triggerId: string;
  data: unknown;
}> = {}): string {
  return JSON.stringify({
    metadata: {
      id: overrides.id ?? "evt_123",
      user_id: overrides.userId ?? "00000000-0000-0000-0000-000000000001",
      trigger_id: overrides.triggerId ?? "ti_abc",
    },
    data: overrides.data ?? { issue: { id: 1 } },
  });
}

describe("verifyWebhookSignature", () => {
  it("accepts a body signed with the current secret", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const headers = buildHeaders("whmsg_1", now, hmacV1(`whmsg_1.${now}.${body}`, SECRET));

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.eventId).toBe("evt_123");
      expect(res.tenantId).toBe("00000000-0000-0000-0000-000000000001");
      expect(res.triggerId).toBe("ti_abc");
      expect(res.body).toMatchObject({ data: { issue: { id: 1 } } });
    }
  });

  it("accepts a body signed with the _PREVIOUS secret during rotation", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const headers = buildHeaders("whmsg_2", now, hmacV1(`whmsg_2.${now}.${body}`, PREV_SECRET));

    const res = verifyWebhookSignature(body, headers, {
      secret: SECRET,
      previousSecret: PREV_SECRET,
      nowSeconds: now,
    });

    expect(res.ok).toBe(true);
  });

  it("accepts a header containing multiple space-separated signatures", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const validSig = hmacV1(`whmsg_3.${now}.${body}`, SECRET);
    const invalidSig = "v1,garbage-base64==";
    const headers = buildHeaders("whmsg_3", now, `${invalidSig} ${validSig}`);

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res.ok).toBe(true);
  });

  it("rejects when headers are missing", () => {
    const res = verifyWebhookSignature("{}", {}, { secret: SECRET, nowSeconds: 1 });
    expect(res).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects when timestamp is outside the 300s replay window (past)", () => {
    const now = 1_700_000_000;
    const stale = now - REPLAY_WINDOW_SECONDS - 1;
    const body = buildBody();
    const headers = buildHeaders("whmsg_4", stale, hmacV1(`whmsg_4.${stale}.${body}`, SECRET));

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "timestamp_out_of_window" });
  });

  it("rejects when timestamp is outside the 300s replay window (future)", () => {
    const now = 1_700_000_000;
    const future = now + REPLAY_WINDOW_SECONDS + 1;
    const body = buildBody();
    const headers = buildHeaders("whmsg_5", future, hmacV1(`whmsg_5.${future}.${body}`, SECRET));

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "timestamp_out_of_window" });
  });

  it("rejects bad signature header format", () => {
    const now = 1_700_000_000;
    const headers = buildHeaders("whmsg_6", now, "this-has-no-comma");
    const res = verifyWebhookSignature("{}", headers, { secret: SECRET, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "bad_header_format" });
  });

  it("rejects a tampered body", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const tamperedBody = body.replace("1", "2"); // mutate one byte
    const headers = buildHeaders("whmsg_7", now, hmacV1(`whmsg_7.${now}.${body}`, SECRET));

    const res = verifyWebhookSignature(tamperedBody, headers, { secret: SECRET, nowSeconds: now });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_mismatch");
  });

  it("rejects when signature length differs (no throw)", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const truncated = "v1," + hmacV1(`whmsg_8.${now}.${body}`, SECRET).slice(3, -4); // truncated base64
    const headers = buildHeaders("whmsg_8", now, truncated);
    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res.ok).toBe(false);
  });

  it("rejects body that isn't valid JSON after signature passes", () => {
    const now = 1_700_000_000;
    const body = "not json";
    const headers = buildHeaders("whmsg_9", now, hmacV1(`whmsg_9.${now}.${body}`, SECRET));

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "bad_body" });
  });

  it("rejects when signed body is missing required metadata fields", () => {
    const now = 1_700_000_000;
    const body = JSON.stringify({ metadata: { id: "e1" } }); // missing user_id + trigger_id
    const headers = buildHeaders("whmsg_10", now, hmacV1(`whmsg_10.${now}.${body}`, SECRET));

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "missing_metadata" });
  });

  it("rejects when no secret is configured", () => {
    const res = verifyWebhookSignature("{}", {}, { nowSeconds: 1 });
    expect(res).toEqual({ ok: false, reason: "no_secret_configured" });
  });

  it("is tolerant of Headers instances (not just plain objects)", () => {
    const now = 1_700_000_000;
    const body = buildBody();
    const headers = new Headers({
      "Webhook-Id": "whmsg_11",
      "Webhook-Timestamp": String(now),
      "Webhook-Signature": hmacV1(`whmsg_11.${now}.${body}`, SECRET),
    });

    const res = verifyWebhookSignature(body, headers, { secret: SECRET, nowSeconds: now });
    expect(res.ok).toBe(true);
  });
});
