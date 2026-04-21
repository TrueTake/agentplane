import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import { enableTrigger } from "@/lib/composio-triggers";
import {
  getTriggerById,
  updateTrigger,
} from "@/lib/webhook-triggers";
import type { WebhookTriggerId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; triggerId: string }> };

export const POST = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, triggerId } = await (context as RouteContext).params;
  const current = await getTriggerById(triggerId as WebhookTriggerId);
  if (!current || current.agent_id !== agentId) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }
  if (current.pending_cancel) {
    return NextResponse.json(
      { error: { code: "PENDING_CANCEL", message: "Trigger is pending cancellation and cannot be enabled." } },
      { status: 400 },
    );
  }

  const updated = await updateTrigger(triggerId as WebhookTriggerId, { enabled: true });
  if (!updated) {
    return NextResponse.json({ error: { code: "not_found", message: "Trigger not found" } }, { status: 404 });
  }

  try {
    await enableTrigger(updated.composio_trigger_id);
  } catch (err) {
    logger.warn("triggers enable: upstream enable failed", {
      triggerId,
      composioTriggerId: updated.composio_trigger_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json(updated);
});
