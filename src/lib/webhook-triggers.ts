// Pure DB helpers for webhook_triggers + webhook_deliveries. No route handlers,
// no Composio calls — those live in the route files that compose these helpers
// with src/lib/composio-triggers.ts.
//
// Admin routes run without RLS context (no withTenantTransaction), matching
// the pattern used by src/app/api/admin/agents/[agentId]/schedules/route.ts.

import { z } from "zod";
import { query, queryOne, execute } from "@/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import type {
  AgentId,
  TenantId,
  WebhookDeliveryStatus,
  WebhookTriggerId,
  WebhookTriggerToolEntry,
} from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// Row schemas
// ──────────────────────────────────────────────────────────────────────────

// Shape of the encrypted-payload JSONB blob (crypto.encrypt output).
const EncryptedPayloadSchema = z.object({
  version: z.number(),
  iv: z.string(),
  ciphertext: z.string(),
});

// WebhookTriggerToolEntry shape; mirrors src/lib/types.ts.
const ToolAllowlistEntrySchema = z.object({
  claude: z.string(),
  aiSdk: z.string(),
});

// Filter predicate is a free-form JSONB object (dot-path → value map);
// evaluated post-signature by the webhook route. NULL means "no filter".
const FilterPredicateSchema = z.record(z.string(), z.unknown()).nullable();

export const WebhookTriggerRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  toolkit_slug: z.string(),
  trigger_type: z.string(),
  composio_trigger_id: z.string(),
  prompt_template: z.string(),
  filter_predicate: FilterPredicateSchema,
  tool_allowlist: z.array(ToolAllowlistEntrySchema),
  enabled: z.boolean(),
  pending_cancel: z.boolean(),
  last_cancel_attempt_at: z.coerce.date().nullable(),
  cancel_attempts: z.coerce.number(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type WebhookTrigger = z.infer<typeof WebhookTriggerRow>;

export const WebhookDeliveryRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  webhook_trigger_id: z.string(),
  composio_event_id: z.string(),
  received_at: z.coerce.date(),
  status: z.enum([
    "received",
    "accepted",
    "rejected_429",
    "signature_failed",
    "trigger_disabled",
    "budget_blocked",
    "filtered",
    "run_failed_to_create",
  ]),
  run_id: z.string().nullable(),
  payload_snapshot: EncryptedPayloadSchema.nullable(),
  payload_truncated: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type WebhookDelivery = z.infer<typeof WebhookDeliveryRow>;

// ──────────────────────────────────────────────────────────────────────────
// Input schemas
// ──────────────────────────────────────────────────────────────────────────

export const CreateTriggerInput = z
  .object({
    toolkitSlug: z.string().min(1).max(100),
    triggerType: z.string().min(1).max(150),
    promptTemplate: z.string().min(1).max(50_000),
    filterPredicate: FilterPredicateSchema.optional(),
    toolAllowlist: z.array(ToolAllowlistEntrySchema).max(200),
    enabled: z.boolean().default(false),
    confirmZeroTools: z.boolean().optional(),
  })
  .strict();

export type CreateTriggerInputT = z.infer<typeof CreateTriggerInput>;

// Update input: toolkitSlug / triggerType / composio_trigger_id are immutable
// via PATCH; callers must delete-and-recreate to change them. Reject unknown
// fields.
export const UpdateTriggerInput = z
  .object({
    promptTemplate: z.string().min(1).max(50_000).optional(),
    filterPredicate: FilterPredicateSchema.optional(),
    toolAllowlist: z.array(ToolAllowlistEntrySchema).max(200).optional(),
    enabled: z.boolean().optional(),
    // These two are captured only so the PATCH route can detect illegal
    // attempts to mutate them and return a 400 with a clear message.
    toolkitSlug: z.string().min(1).max(100).optional(),
    triggerType: z.string().min(1).max(150).optional(),
  })
  .strict();

export type UpdateTriggerInputT = z.infer<typeof UpdateTriggerInput>;

// ──────────────────────────────────────────────────────────────────────────
// Insert input (internal — the route builds this after Composio returns the id)
// ──────────────────────────────────────────────────────────────────────────

export interface InsertTriggerRow {
  tenantId: TenantId;
  agentId: AgentId;
  toolkitSlug: string;
  triggerType: string;
  composioTriggerId: string;
  promptTemplate: string;
  filterPredicate: Record<string, unknown> | null;
  toolAllowlist: WebhookTriggerToolEntry[];
  enabled: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

export async function listTriggers(agentId: AgentId): Promise<WebhookTrigger[]> {
  return query(
    WebhookTriggerRow,
    "SELECT * FROM webhook_triggers WHERE agent_id = $1 ORDER BY created_at ASC",
    [agentId],
  );
}

export async function getTriggerById(
  triggerId: WebhookTriggerId,
): Promise<WebhookTrigger | null> {
  return queryOne(
    WebhookTriggerRow,
    "SELECT * FROM webhook_triggers WHERE id = $1",
    [triggerId],
  );
}

export async function insertTrigger(row: InsertTriggerRow): Promise<WebhookTrigger> {
  const inserted = await queryOne(
    WebhookTriggerRow,
    `INSERT INTO webhook_triggers (
       tenant_id, agent_id, toolkit_slug, trigger_type, composio_trigger_id,
       prompt_template, filter_predicate, tool_allowlist, enabled
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      row.tenantId,
      row.agentId,
      row.toolkitSlug,
      row.triggerType,
      row.composioTriggerId,
      row.promptTemplate,
      row.filterPredicate ? JSON.stringify(row.filterPredicate) : null,
      JSON.stringify(row.toolAllowlist),
      row.enabled,
    ],
  );
  if (!inserted) throw new Error("insertTrigger: INSERT … RETURNING returned no rows");
  return inserted;
}

// Dynamic PATCH: only the fields in `patch` are updated. Pass camelCase keys
// matching the column names used by UpdateTriggerInput; this function maps them
// to snake_case columns and JSON-serializes JSONB values.
export async function updateTrigger(
  triggerId: WebhookTriggerId,
  patch: {
    promptTemplate?: string;
    filterPredicate?: Record<string, unknown> | null;
    toolAllowlist?: WebhookTriggerToolEntry[];
    enabled?: boolean;
  },
): Promise<WebhookTrigger | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (patch.promptTemplate !== undefined) {
    sets.push(`prompt_template = $${idx++}`);
    params.push(patch.promptTemplate);
  }
  if (patch.filterPredicate !== undefined) {
    sets.push(`filter_predicate = $${idx++}`);
    params.push(patch.filterPredicate === null ? null : JSON.stringify(patch.filterPredicate));
  }
  if (patch.toolAllowlist !== undefined) {
    sets.push(`tool_allowlist = $${idx++}`);
    params.push(JSON.stringify(patch.toolAllowlist));
  }
  if (patch.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    params.push(patch.enabled);
  }

  if (sets.length === 0) {
    // No-op patch — just return the current row.
    return getTriggerById(triggerId);
  }

  params.push(triggerId);
  return queryOne(
    WebhookTriggerRow,
    `UPDATE webhook_triggers SET ${sets.join(", ")}, updated_at = NOW()
     WHERE id = $${idx}
     RETURNING *`,
    params,
  );
}

export async function markTriggerPendingCancel(
  triggerId: WebhookTriggerId,
): Promise<void> {
  await execute(
    `UPDATE webhook_triggers
     SET pending_cancel = true, enabled = false, updated_at = NOW()
     WHERE id = $1`,
    [triggerId],
  );
}

export async function markTriggersPendingCancelForAgent(
  agentId: AgentId,
): Promise<number> {
  const result = await execute(
    `UPDATE webhook_triggers
     SET pending_cancel = true, enabled = false, updated_at = NOW()
     WHERE agent_id = $1 AND pending_cancel = false`,
    [agentId],
  );
  return result.rowCount;
}

export async function markTriggersPendingCancelForToolkit(
  agentId: AgentId,
  toolkitSlug: string,
): Promise<number> {
  const result = await execute(
    `UPDATE webhook_triggers
     SET pending_cancel = true, enabled = false, updated_at = NOW()
     WHERE agent_id = $1 AND toolkit_slug = $2 AND pending_cancel = false`,
    [agentId, toolkitSlug.toLowerCase()],
  );
  return result.rowCount;
}

export async function countActiveTriggers(agentId: AgentId): Promise<number> {
  const row = await queryOne(
    z.object({ count: z.coerce.number() }),
    `SELECT COUNT(*)::int AS count
     FROM webhook_triggers
     WHERE agent_id = $1 AND enabled = true AND pending_cancel = false`,
    [agentId],
  );
  return row?.count ?? 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Delivery log
// ──────────────────────────────────────────────────────────────────────────

export interface ListDeliveriesOptions {
  limit?: number;
  offset?: number;
}

export async function listDeliveries(
  tenantId: TenantId,
  triggerId: WebhookTriggerId,
  opts: ListDeliveriesOptions = {},
): Promise<WebhookDelivery[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  return query(
    WebhookDeliveryRow,
    `SELECT * FROM webhook_deliveries
     WHERE tenant_id = $1 AND webhook_trigger_id = $2
     ORDER BY received_at DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, triggerId, limit, offset],
  );
}

export async function countDeliveries(
  tenantId: TenantId,
  triggerId: WebhookTriggerId,
): Promise<number> {
  const row = await queryOne(
    z.object({ count: z.coerce.number() }),
    `SELECT COUNT(*)::int AS count FROM webhook_deliveries
     WHERE tenant_id = $1 AND webhook_trigger_id = $2`,
    [tenantId, triggerId],
  );
  return row?.count ?? 0;
}

export interface DecryptedDeliveryPayload {
  plaintext: string;
  truncated: boolean;
}

/**
 * Decrypt a delivery's payload_snapshot using the current ENCRYPTION_KEY with
 * fallback to ENCRYPTION_KEY_PREVIOUS (key-rotation pattern matching
 * src/lib/mcp-connections.ts refreshAccessToken).
 *
 * Returns null plaintext if the delivery had no snapshot (e.g. a
 * signature_failed delivery that never persisted the payload).
 */
export async function decryptDeliveryPayload(
  row: Pick<WebhookDelivery, "payload_snapshot" | "payload_truncated">,
): Promise<DecryptedDeliveryPayload | null> {
  if (!row.payload_snapshot) return null;
  const env = getEnv();
  const plaintext = await decrypt(
    row.payload_snapshot,
    env.ENCRYPTION_KEY,
    env.ENCRYPTION_KEY_PREVIOUS,
  );
  return { plaintext, truncated: row.payload_truncated };
}

// Re-export encrypt so the webhook ingress route (Unit 6) can snapshot
// payloads via a single import surface; keeps all crypto access in this
// module so the key-rotation pattern is centralized.
export { encrypt as encryptDeliveryPayload };

// Re-export a few types for callers that only want to import from this module.
export type { WebhookDeliveryStatus };
