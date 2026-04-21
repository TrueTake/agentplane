import { z } from "zod";

const EnvSchema = z.object({
  // Neon
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_DIRECT: z.string().optional(),

  // Vercel Blob
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  // Vercel Cron
  CRON_SECRET: z.string().min(1, "CRON_SECRET is required"),

  // Platform security
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
  ENCRYPTION_KEY_PREVIOUS: z.string().length(64).optional(),
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Composio
  COMPOSIO_API_KEY: z.string().optional(),
  // HMAC secret for verifying Composio webhook deliveries (Standard Webhooks).
  // Optional: feature degrades gracefully — triggers can be created but all
  // deliveries will fail signature verification until the secret is set.
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  // Previous secret accepted during rotation. After rotating in the Composio
  // dashboard: set _PREVIOUS to the old secret, SECRET to the new secret,
  // deploy, wait for in-flight deliveries to drain (~1 hr), then remove _PREVIOUS.
  COMPOSIO_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),

  // Vercel AI Gateway
  AI_GATEWAY_API_KEY: z.string().min(1, "AI_GATEWAY_API_KEY is required"),

  // Braintrust (observability)
  BRAINTRUST_API_KEY: z.string().optional(),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  _env = result.data;
  return _env;
}

export function resetEnvCache() {
  _env = null;
}
