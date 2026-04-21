import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import {
  countDeliveries,
  decryptDeliveryPayload,
  getTriggerById,
  listDeliveries,
} from "@/lib/webhook-triggers";
import type { TenantId, WebhookTriggerId } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAYLOAD_PREVIEW_CAP = 500;

type RouteContext = { params: Promise<{ agentId: string; triggerId: string }> };

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, triggerId } = await (context as RouteContext).params;
  const url = new URL(request.url);
  const { limit, offset } = QuerySchema.parse({
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });

  // Verify the agent exists and use its tenant_id as the authoritative scoping
  // for the deliveries query. Plan originally said "admin-session tenantId"
  // but this repo has no such concept — the agent row is the correct anchor.
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const trigger = await getTriggerById(triggerId as WebhookTriggerId);
  if (!trigger || trigger.agent_id !== agentId) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }

  const tenantId = agent.tenant_id as TenantId;
  const rows = await listDeliveries(tenantId, triggerId as WebhookTriggerId, { limit, offset });
  const total = await countDeliveries(tenantId, triggerId as WebhookTriggerId);

  const items = await Promise.all(
    rows.map(async (row) => {
      let payload_preview: string | null = null;
      try {
        const decrypted = await decryptDeliveryPayload(row);
        if (decrypted) {
          payload_preview = decrypted.plaintext.slice(0, PAYLOAD_PREVIEW_CAP);
        }
      } catch (err) {
        logger.warn("trigger deliveries: failed to decrypt payload_snapshot", {
          deliveryId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        id: row.id,
        composio_event_id: row.composio_event_id,
        received_at: row.received_at,
        status: row.status,
        run_id: row.run_id,
        payload_truncated: row.payload_truncated,
        payload_preview,
      };
    }),
  );

  return NextResponse.json({
    items,
    total,
    limit: limit ?? 50,
    offset: offset ?? 0,
  });
});
