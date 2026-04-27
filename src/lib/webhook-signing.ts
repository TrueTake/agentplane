import { timingSafeEqual } from "./crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = "sha256=";

export interface VerifyResult {
  valid: boolean;
  reason?: "malformed" | "mismatch" | "stale";
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signPayload(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`).buffer as ArrayBuffer,
  );
  return `${SIGNATURE_PREFIX}${bufferToHex(signed)}`;
}

export async function verifySignature(
  secret: string,
  signature: string,
  timestamp: string,
  rawBody: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<VerifyResult> {
  if (!signature || !signature.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false, reason: "malformed" };
  }

  const tsNumber = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNumber) || tsNumber <= 0) {
    return { valid: false, reason: "malformed" };
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNumber);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: "stale" };
  }

  const expected = await signPayload(secret, timestamp, rawBody);
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true };
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `whsec_${hex}`;
}
