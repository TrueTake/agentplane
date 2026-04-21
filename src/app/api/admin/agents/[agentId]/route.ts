import { NextRequest, NextResponse } from "next/server";
import { queryOne, query, execute, getPool } from "@/db";
import { AgentRow, RunRow, UpdateAgentSchema } from "@/lib/validation";
import { removeToolkitConnections } from "@/lib/composio";
import { resolveEffectiveRunner, isPermissionModeAllowed } from "@/lib/models";
import { withErrorHandler } from "@/lib/api";
import { deriveIdentity } from "@/lib/identity";
import { logger } from "@/lib/logger";
import {
  disableTrigger as composioDisableTrigger,
  deleteTrigger as composioDeleteTrigger,
} from "@/lib/composio-triggers";
import {
  countActiveTriggers,
  listTriggers,
  markTriggersPendingCancelForToolkit,
} from "@/lib/webhook-triggers";
import type { AgentId } from "@/lib/types";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const recentRuns = await query(
    RunRow,
    "SELECT * FROM runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20",
    [agentId],
  );

  return NextResponse.json({ agent, recent_runs: recentRuns });
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = UpdateAgentSchema.parse(body);

  // Fetch current agent to detect removed toolkits before applying the update.
  const current = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!current) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  // Validate marketplace_id references exist before writing
  if (input.plugins !== undefined && input.plugins.length > 0) {
    const marketplaceIds = [...new Set(input.plugins.map(p => p.marketplace_id))];
    const existing = await query(
      z.object({ id: z.string() }),
      "SELECT id FROM plugin_marketplaces WHERE id = ANY($1)",
      [marketplaceIds],
    );
    const existingIds = new Set(existing.map(r => r.id));
    const missing = marketplaceIds.filter(id => !existingIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: { code: "validation_error", message: `Unknown marketplace_id(s): ${missing.join(", ")}` } },
        { status: 422 },
      );
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  let identityWarnings: { file: string; message: string }[] = [];

  // Reject permission_mode incompatible with Vercel AI SDK runner
  // Check whenever model, runner, OR permission_mode changes (prevents two-step bypass)
  if (input.permission_mode !== undefined || input.model !== undefined || input.runner !== undefined) {
    const effectiveModel = input.model ?? current.model;
    const effectiveRunner = resolveEffectiveRunner(effectiveModel, input.runner !== undefined ? input.runner : current.runner);
    const effectivePermission = input.permission_mode ?? current.permission_mode;
    if (!isPermissionModeAllowed(effectiveRunner, effectivePermission)) {
      return NextResponse.json(
        { error: { code: "validation_error", message: "Vercel AI SDK runner does not support permission modes other than 'default' and 'bypassPermissions'" } },
        { status: 400 },
      );
    }

    // R11 (post-save plan-mode transition): forbid switching an agent to plan
    // mode while it has active triggers. Operator must explicitly disable the
    // triggers first so we don't silently orphan webhook subscriptions.
    if (effectivePermission === "plan" && current.permission_mode !== "plan") {
      const activeCount = await countActiveTriggers(agentId as AgentId);
      if (activeCount > 0) {
        return NextResponse.json(
          {
            error: {
              code: "AGENT_HAS_ACTIVE_TRIGGERS",
              message: `Cannot switch to plan mode while ${activeCount} active trigger(s) exist. Disable or delete them first.`,
              active_trigger_count: activeCount,
            },
          },
          { status: 400 },
        );
      }
    }
  }

  // Block slug changes when a2a_enabled is true (slug is used in permanent A2A URLs)
  if (input.slug !== undefined && current.a2a_enabled) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "Cannot change slug while A2A is enabled. Disable A2A first." } },
      { status: 422 },
    );
  }

  const fieldMap: Array<[keyof typeof input, string, ((v: unknown) => unknown)?]> = [
    ["name", "name"],
    ["slug", "slug"],
    ["description", "description"],
    ["model", "model"],
    ["runner", "runner"],
    ["permission_mode", "permission_mode"],
    ["max_turns", "max_turns"],
    ["max_budget_usd", "max_budget_usd"],
    ["max_runtime_seconds", "max_runtime_seconds"],
    ["composio_toolkits", "composio_toolkits"],
    ["composio_allowed_tools", "composio_allowed_tools"],
    ["skills", "skills", (v) => JSON.stringify(v)],
    ["plugins", "plugins", (v) => JSON.stringify(v)],
    ["a2a_enabled", "a2a_enabled"],
    ["a2a_tags", "a2a_tags"],
    ["soul_md", "soul_md"],
    ["identity_md", "identity_md"],
    ["style_md", "style_md"],
    ["agents_md", "agents_md"],
    ["heartbeat_md", "heartbeat_md"],
    ["user_template_md", "user_template_md"],
    ["examples_good_md", "examples_good_md"],
    ["examples_bad_md", "examples_bad_md"],
    ["soul_spec_version", "soul_spec_version"],
  ];

  for (const [field, col, transform] of fieldMap) {
    if (input[field] !== undefined) {
      const val = transform ? transform(input[field]) : input[field];
      sets.push(`${col} = $${idx++}`);
      params.push(val);
    }
  }

  // Derive identity JSONB when any identity-related markdown changes
  const identityFields = ["soul_md", "identity_md", "style_md", "agents_md", "heartbeat_md", "user_template_md", "examples_good_md", "examples_bad_md"] as const;
  if (identityFields.some(f => (input as Record<string, unknown>)[f] !== undefined)) {
    const cur = current as Record<string, unknown>;
    const eff = (f: string) => (input as Record<string, unknown>)[f] !== undefined ? (input as Record<string, unknown>)[f] as string | null : cur[f] as string | null;
    const parseResult = deriveIdentity(eff("soul_md"), eff("identity_md"), eff("style_md"), eff("agents_md"), eff("heartbeat_md"), eff("user_template_md"), eff("examples_good_md"), eff("examples_bad_md"));
    identityWarnings = parseResult.warnings;
    sets.push(`identity = $${idx++}`);
    params.push(parseResult.identity ? JSON.stringify(parseResult.identity) : null);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: { code: "validation_error", message: "No fields to update" } }, { status: 400 });
  }

  // Use SELECT FOR UPDATE to prevent race with cron dispatcher claiming this agent
  sets.push(`updated_at = NOW()`);
  params.push(agentId);
  const pool = getPool();
  const client = await pool.connect();
  let updatedAgent;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
    const result = await client.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, params);
    await client.query("COMMIT");
    updatedAgent = AgentRow.parse(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof Error && err.message.includes("23505") && err.message.includes("tenant_slug")) {
      return NextResponse.json({ error: { code: "conflict", message: `Slug '${input.slug}' is already taken` } }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }

  // Fire-and-forget: clean up Composio resources for removed toolkits.
  if (input.composio_toolkits !== undefined) {
    const newSet = new Set(input.composio_toolkits.map((t) => t.toLowerCase()));
    const removed = current.composio_toolkits.filter((t) => !newSet.has(t.toLowerCase()));
    if (removed.length > 0) {
      // For each removed toolkit, mark any triggers bound to it pending_cancel
      // AND fire a best-effort disable against Composio so deliveries stop
      // flowing immediately. The cascade-cancel cron (Unit 8) retires the
      // subscription for good later.
      for (const toolkit of removed) {
        await markTriggersPendingCancelForToolkit(agentId as AgentId, toolkit).catch((err) => {
          logger.warn("toolkit removal: mark pending_cancel failed", {
            agentId,
            toolkit,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      // Fire-and-forget disable of Composio subscriptions for the removed
      // toolkits so events stop immediately even if the cascade cron lags.
      listTriggers(agentId as AgentId)
        .then(async (triggers) => {
          const affected = triggers.filter((t) =>
            removed.map((x) => x.toLowerCase()).includes(t.toolkit_slug.toLowerCase()),
          );
          await Promise.allSettled(
            affected.map((t) =>
              composioDisableTrigger(t.composio_trigger_id).catch((err) => {
                logger.warn("toolkit removal: upstream disable failed", {
                  composioTriggerId: t.composio_trigger_id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }),
            ),
          );
        })
        .catch(() => {});

      removeToolkitConnections(current.tenant_id, removed).catch(() => {});
    }
  }

  return NextResponse.json({
    ...updatedAgent,
    ...(identityWarnings.length > 0 ? { identity_warnings: identityWarnings } : {}),
  });
});

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const runCount = await queryOne(
    z.object({ count: z.coerce.number() }),
    "SELECT COUNT(*)::int AS count FROM runs WHERE agent_id = $1 AND status IN ('pending', 'running')",
    [agentId],
  );

  if (runCount && runCount.count > 0) {
    return NextResponse.json(
      { error: { code: "conflict", message: "Cannot delete agent with active runs" } },
      { status: 409 },
    );
  }

  // Clean up Composio connections
  if (agent.composio_toolkits.length > 0) {
    removeToolkitConnections(agent.tenant_id, agent.composio_toolkits).catch(() => {});
  }

  // Webhook triggers: migration 029 defines the agent→trigger FK as
  // ON DELETE RESTRICT so orphan Composio subscriptions can't be created by
  // a bare agent delete. The plan's "mark pending_cancel and proceed" intent
  // is incompatible with RESTRICT (the child rows would still block the
  // DELETE). We resolve by doing a best-effort upstream disable+delete per
  // trigger (bounded by Promise.allSettled with a short timeout so a Composio
  // outage cannot block the agent delete), then hard-delete the trigger rows
  // inline, then the cascade-delivered webhook_deliveries CASCADE with them.
  // Tradeoff: if Composio is down we may leave an orphan subscription upstream
  // that the cascade cron can't reach. Per plan's "agent delete is never
  // blocked" invariant this is acceptable data loss.
  const triggersForAgent = await listTriggers(agentId as AgentId);
  if (triggersForAgent.length > 0) {
    const COMPOSIO_CLEANUP_TIMEOUT_MS = 5_000;
    const cleanup = Promise.allSettled(
      triggersForAgent.map(async (t) => {
        try {
          await composioDisableTrigger(t.composio_trigger_id);
        } catch (err) {
          logger.warn("agent delete: upstream disable failed", {
            composioTriggerId: t.composio_trigger_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await composioDeleteTrigger(t.composio_trigger_id);
        } catch (err) {
          logger.warn("agent delete: upstream delete failed", {
            composioTriggerId: t.composio_trigger_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => setTimeout(resolve, COMPOSIO_CLEANUP_TIMEOUT_MS)),
    ]);
    // Hard delete trigger rows so the RESTRICT FK doesn't block the agent
    // delete below. webhook_deliveries CASCADE on the composite FK.
    await execute("DELETE FROM webhook_triggers WHERE agent_id = $1", [agentId]);
  }

  // Delete related data then the agent
  await execute("DELETE FROM mcp_connections WHERE agent_id = $1", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = $1", [agentId]);
  await execute("DELETE FROM agents WHERE id = $1", [agentId]);

  return NextResponse.json({ deleted: true });
});
