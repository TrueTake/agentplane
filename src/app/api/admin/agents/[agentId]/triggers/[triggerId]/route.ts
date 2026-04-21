import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import {
  disableTrigger,
  enableTrigger,
} from "@/lib/composio-triggers";
import {
  UpdateTriggerInput,
  getTriggerById,
  markTriggerPendingCancel,
  updateTrigger,
} from "@/lib/webhook-triggers";
import type { WebhookTriggerId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; triggerId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, triggerId } = await (context as RouteContext).params;
  const row = await getTriggerById(triggerId as WebhookTriggerId);
  if (!row || row.agent_id !== agentId) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }
  return NextResponse.json(row);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, triggerId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = UpdateTriggerInput.parse(body);

  const current = await getTriggerById(triggerId as WebhookTriggerId);
  if (!current || current.agent_id !== agentId) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }

  // Composio subscriptions are type/toolkit-bound; mutating would silently
  // orphan the upstream subscription. Force delete-and-recreate.
  if (input.toolkitSlug !== undefined || input.triggerType !== undefined) {
    return NextResponse.json(
      {
        error: {
          code: "IMMUTABLE_FIELD",
          message: "toolkitSlug and triggerType cannot be changed. Delete this trigger and create a new one instead.",
        },
      },
      { status: 400 },
    );
  }

  const enabledChanged = input.enabled !== undefined && input.enabled !== current.enabled;

  const updated = await updateTrigger(triggerId as WebhookTriggerId, {
    promptTemplate: input.promptTemplate,
    filterPredicate: input.filterPredicate,
    toolAllowlist: input.toolAllowlist,
    enabled: input.enabled,
  });

  if (!updated) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }

  // Reflect enabled-state change upstream. Keep DB truth authoritative — if
  // Composio is down, the DB still matches the operator's intent and the
  // cron/retry paths can reconcile later. Log at WARN, don't fail the request.
  if (enabledChanged) {
    try {
      if (updated.enabled) {
        await enableTrigger(updated.composio_trigger_id);
      } else {
        await disableTrigger(updated.composio_trigger_id);
      }
    } catch (err) {
      logger.warn("triggers PATCH: upstream enable/disable failed", {
        triggerId,
        composioTriggerId: updated.composio_trigger_id,
        enabled: updated.enabled,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json(updated);
});

// DELETE is soft — marks pending_cancel so the cascade-cancel cron (Unit 8)
// can retire the Composio subscription asynchronously. The DB row survives
// until the cron confirms Composio-side cleanup.
export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, triggerId } = await (context as RouteContext).params;
  const current = await getTriggerById(triggerId as WebhookTriggerId);
  if (!current || current.agent_id !== agentId) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }
  await markTriggerPendingCancel(triggerId as WebhookTriggerId);
  return NextResponse.json({ deleted: true });
});
