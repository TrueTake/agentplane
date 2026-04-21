import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import ComposioClient from "@composio/client";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import { createTrigger as composioCreateTrigger, enableTrigger } from "@/lib/composio-triggers";
import {
  CreateTriggerInput,
  insertTrigger,
  listTriggers,
} from "@/lib/webhook-triggers";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

// GET /api/admin/agents/:agentId/triggers — list all triggers for an agent
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(
    z.object({ id: z.string() }),
    "SELECT id FROM agents WHERE id = $1",
    [agentId],
  );
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const rows = await listTriggers(agentId as AgentId);
  return NextResponse.json(rows);
});

// POST /api/admin/agents/:agentId/triggers — create a new trigger
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = CreateTriggerInput.parse(body);

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  // R11: plan-mode agents cannot have triggers (tool filtering is pre-validated at save
  // time, but plan mode means the agent is not doing tool calls anyway).
  if (agent.permission_mode === "plan") {
    return NextResponse.json(
      { error: { code: "AGENT_IN_PLAN_MODE", message: "Cannot create triggers on a plan-mode agent. Change permission_mode to run tools." } },
      { status: 400 },
    );
  }

  // R10a: empty allowlist requires explicit operator confirmation.
  if (input.toolAllowlist.length === 0 && !input.confirmZeroTools) {
    return NextResponse.json(
      { error: {
        code: "ZERO_TOOL_CONFIRMATION_REQUIRED",
        message: "Empty tool allowlist — set confirmZeroTools: true to acknowledge creating a zero-tool trigger.",
      } },
      { status: 400 },
    );
  }

  // Toolkit must already be connected on the agent. Verify against the agent's
  // composio_toolkits list before hitting Composio.
  if (!agent.composio_toolkits.map((s) => s.toLowerCase()).includes(input.toolkitSlug.toLowerCase())) {
    return NextResponse.json(
      { error: { code: "validation_error", message: `Toolkit '${input.toolkitSlug}' is not connected to this agent` } },
      { status: 400 },
    );
  }

  // Look up the connected account id for (tenant, toolkit). Mirrors
  // getConnectorStatuses in src/lib/composio.ts:421.
  let connectedAccountId: string | undefined;
  const composioApiKey = process.env.COMPOSIO_API_KEY;
  if (composioApiKey) {
    try {
      const client = new ComposioClient({ apiKey: composioApiKey });
      const caRes = await client.connectedAccounts.list({
        toolkit_slugs: [input.toolkitSlug.toLowerCase()],
        user_ids: [agent.tenant_id],
        limit: 5,
      });
      connectedAccountId = caRes.items[0]?.id ?? undefined;
    } catch (err) {
      logger.error("triggers POST: connectedAccounts.list failed", {
        tenantId: agent.tenant_id,
        toolkit: input.toolkitSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: { code: "upstream_error", message: "Failed to look up Composio connected account" } },
        { status: 502 },
      );
    }
  }

  // Create the Composio subscription (AgentPlane-side filter_predicate is NOT
  // passed — it's evaluated post-signature by the webhook route). Surface the
  // sanitized upstream message on failure so the operator can act on it,
  // rather than falling through to the generic 500.
  let composioTriggerId: string;
  try {
    const res = await composioCreateTrigger({
      userId: agent.tenant_id,
      triggerType: input.triggerType,
      connectedAccountId,
    });
    composioTriggerId = res.composioTriggerId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("triggers POST: composio create failed", {
      tenantId: agent.tenant_id,
      triggerType: input.triggerType,
      connectedAccountId,
      error: message,
    });
    return NextResponse.json(
      { error: { code: "COMPOSIO_CREATE_FAILED", message } },
      { status: 502 },
    );
  }

  // Persist the DB row.
  let row;
  try {
    row = await insertTrigger({
      tenantId: agent.tenant_id as TenantId,
      agentId: agentId as AgentId,
      toolkitSlug: input.toolkitSlug.toLowerCase(),
      triggerType: input.triggerType,
      composioTriggerId,
      promptTemplate: input.promptTemplate,
      filterPredicate: input.filterPredicate ?? null,
      toolAllowlist: input.toolAllowlist,
      enabled: input.enabled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("triggers POST: insert row failed after composio create", {
      agentId,
      composioTriggerId,
      error: message,
    });
    return NextResponse.json(
      { error: { code: "DB_INSERT_FAILED", message } },
      { status: 500 },
    );
  }

  // If the operator flipped enabled on create, fire a separate enable call.
  // Composio's create defaults to enabled=true on some plans, but we call
  // enable/disable explicitly so DB truth matches upstream truth.
  if (input.enabled) {
    try {
      await enableTrigger(composioTriggerId);
    } catch (err) {
      logger.warn("triggers POST: enable call failed post-create", {
        composioTriggerId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't fail the create — operator can retry enable from the UI.
    }
  }

  return NextResponse.json(row, { status: 201 });
});
