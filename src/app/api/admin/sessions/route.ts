import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { PaginationSchema, SessionStatusSchema, AgentRowInternal } from "@/lib/validation";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { createSession, transitionSessionStatus } from "@/lib/sessions";
import { prepareSessionSandbox, executeSessionMessage, createSessionStreamResponse } from "@/lib/session-executor";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SessionWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  status: z.string(),
  message_count: z.coerce.number(),
  sandbox_id: z.string().nullable(),
  idle_since: z.coerce.string().nullable(),
  last_message_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;
  const tenantId = url.searchParams.get("tenant_id");
  const agentId = url.searchParams.get("agent_id");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`s.status = $${idx++}`);
    params.push(status);
  }
  if (tenantId) {
    conditions.push(`s.tenant_id = $${idx++}`);
    params.push(tenantId);
  }
  if (agentId) {
    conditions.push(`s.agent_id = $${idx++}`);
    params.push(agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const sessions = await query(
    SessionWithContext,
    `SELECT s.id, s.agent_id, a.name AS agent_name, s.tenant_id, t.name AS tenant_name,
       s.status, s.message_count, s.sandbox_id, s.idle_since,
       s.last_message_at, s.created_at, s.updated_at
     FROM sessions s
     JOIN agents a ON a.id = s.agent_id
     JOIN tenants t ON t.id = s.tenant_id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return NextResponse.json({ data: sessions, limit, offset });
});

const AdminCreateSessionSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1).max(100_000).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = AdminCreateSessionSchema.parse(body);

  // Look up agent (no RLS) to get tenant_id
  const agentRow = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [input.agent_id],
  );
  if (!agentRow) throw new NotFoundError("Agent not found");
  const agent = agentRow;

  const tenantId = agent.tenant_id as TenantId;
  const { session, remainingBudget } = await createSession(tenantId, input.agent_id as AgentId);

  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);

  let sandbox: Awaited<ReturnType<typeof prepareSessionSandbox>>;
  try {
    sandbox = await prepareSessionSandbox(
      {
        sessionId: session.id,
        tenantId,
        agent,
        prompt: input.prompt ?? "",
        platformApiUrl: new URL(request.url).origin,
        effectiveBudget,
        effectiveMaxTurns: agent.max_turns,
      },
      session,
    );
  } catch (err) {
    await transitionSessionStatus(session.id, tenantId, "creating", "stopped", {
      idle_since: null,
    }).catch((transErr) => {
      logger.error("Failed to transition session to stopped after sandbox failure", {
        session_id: session.id,
        error: transErr instanceof Error ? transErr.message : String(transErr),
      });
    });
    throw err;
  }

  if (!input.prompt) {
    await transitionSessionStatus(session.id, tenantId, "creating", "idle", {
      sandbox_id: sandbox.id,
      idle_since: new Date().toISOString(),
    });

    return jsonResponse({
      id: session.id,
      agent_id: session.agent_id,
      tenant_id: tenantId,
      status: "idle",
      message_count: 0,
      created_at: session.created_at,
    }, 201);
  }

  // Transition creating → active before executing message
  await transitionSessionStatus(session.id, tenantId, "creating", "active", {
    idle_since: null,
  });

  const result = await executeSessionMessage(
    {
      sessionId: session.id,
      tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns: agent.max_turns,
    },
    sandbox,
    { ...session, sandbox_id: sandbox.id },
  );

  return createSessionStreamResponse(result, tenantId, session.id, effectiveBudget, {
    prelude: [JSON.stringify({
      type: "session_created",
      session_id: session.id,
      agent_id: session.agent_id,
      timestamp: new Date().toISOString(),
    })],
  });
});
