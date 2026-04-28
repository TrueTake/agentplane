import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { AgentRowInternal, TenantRow, ScheduleRow } from "@/lib/validation";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { transitionMessageStatus } from "@/lib/session-messages";
import { BudgetExceededError, ConcurrencyLimitError } from "@/lib/errors";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

const ExecuteSchema = z.object({
  schedule_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const body = await request.json();
  const { schedule_id } = ExecuteSchema.parse(body);

  // Load schedule from DB (never trust POST body for anything besides schedule_id)
  const schedule = await queryOne(
    ScheduleRow,
    "SELECT * FROM schedules WHERE id = $1",
    [schedule_id],
  );
  if (!schedule || !schedule.enabled || !schedule.prompt) {
    logger.warn("Scheduled run skipped: schedule not found or not enabled", { schedule_id });
    return jsonResponse({ status: "skipped", reason: "not_schedulable" });
  }

  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [schedule.agent_id],
  );
  if (!agent) {
    logger.warn("Scheduled run skipped: agent not found", { schedule_id, agent_id: schedule.agent_id });
    return jsonResponse({ status: "skipped", reason: "agent_not_found" });
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
  if (!tenant || tenant.status === "suspended") {
    logger.warn("Scheduled run skipped: tenant suspended or not found", {
      schedule_id,
      agent_id: agent.id,
      tenant_id: agent.tenant_id,
    });
    return jsonResponse({ status: "skipped", reason: "tenant_suspended" });
  }

  const tenantId = agent.tenant_id as TenantId;
  const agentId = agent.id as AgentId;

  // U4: dispatch through the unified chokepoint. Schedule runs are PERSISTENT
  // (ephemeral=false) so a short follow-up window (idle TTL of 300s, set by
  // the dispatcher's per-trigger default) lets a follow-up cron tick reuse
  // the warm sandbox. The cleanup cron stops idle schedule sessions after
  // the per-row TTL elapses.
  let messageId: string;
  try {
    const dispatchResult = await dispatchSessionMessage({
      tenantId,
      agentId,
      prompt: schedule.prompt,
      triggeredBy: "schedule",
      ephemeral: false,
      callerKeyId: null,
      platformApiUrl: getCallbackBaseUrl(),
    });
    messageId = dispatchResult.messageId;

    // Drain the dispatcher stream so finalize hooks fire. The schedule cron
    // function instance bounds this with its 5-min maxDuration; long-running
    // schedule prompts detach naturally via the dispatcher's stream-detach
    // path.
    const reader = dispatchResult.stream.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  } catch (err) {
    if (err instanceof ConcurrencyLimitError || err instanceof BudgetExceededError) {
      const reason = err instanceof ConcurrencyLimitError ? "concurrency_limit" : "budget_exceeded";
      logger.warn("Scheduled run dispatch skipped", {
        schedule_id,
        agent_id: agent.id,
        reason,
        error: err.message,
      });
      return jsonResponse({ status: "skipped", reason });
    }
    logger.error("Scheduled run dispatch failed", {
      schedule_id,
      agent_id: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ status: "failed", reason: "dispatch_error" });
  }

  // If the dispatcher stream finished but the message status is still
  // "running" (for example, the runner crashed silently), best-effort
  // transition to failed so the schedule tick doesn't leave a stuck row.
  await transitionMessageStatus(messageId, tenantId, "running", "failed", {
    completed_at: new Date().toISOString(),
    error_type: "schedule_no_terminal_event",
    error_messages: ["Scheduled run ended without terminal event"],
  }).catch(() => {
    // No-op when the message already finalized — this is the happy path.
  });

  logger.info("Scheduled run completed", { schedule_id, agent_id: agent.id, message_id: messageId });
  return jsonResponse({ status: "triggered", message_id: messageId });
});
