import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateSessionSchema, PaginationSchema, SessionStatusSchema, SessionResponseRow } from "@/lib/validation";
import { createSession, listSessions } from "@/lib/sessions";
import { prepareSessionSandbox, executeSessionMessage, createSessionStreamResponse } from "@/lib/session-executor";
import { transitionSessionStatus } from "@/lib/sessions";
import { logger } from "@/lib/logger";
import type { AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateSessionSchema.parse(body);

  const { session, agent, remainingBudget } = await createSession(auth.tenantId, input.agent_id as AgentId);

  // Cap effectiveBudget to remaining tenant budget
  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);

  // Prepare sandbox (cold start)
  let sandbox: Awaited<ReturnType<typeof prepareSessionSandbox>>;
  try {
    sandbox = await prepareSessionSandbox(
    {
      sessionId: session.id,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt ?? "",
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns: agent.max_turns,
    },
    session,
  );
  } catch (err) {
    // Transition session to stopped on sandbox creation failure
    await transitionSessionStatus(session.id, auth.tenantId, "creating", "stopped", {
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
    // No prompt: just create session with warm sandbox, transition to idle
    await transitionSessionStatus(session.id, auth.tenantId, "creating", "idle", {
      sandbox_id: sandbox.id,
      idle_since: new Date().toISOString(),
    });

    const updatedSession = SessionResponseRow.parse({
      ...session,
      status: "idle",
      sandbox_id: sandbox.id,
      idle_since: new Date().toISOString(),
    });
    return jsonResponse(updatedSession, 201);
  }

  // Transition creating → active before executing message
  await transitionSessionStatus(session.id, auth.tenantId, "creating", "active", {
    idle_since: null,
  });

  // With prompt: execute first message and stream response
  const result = await executeSessionMessage(
    {
      sessionId: session.id,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns: agent.max_turns,
    },
    sandbox,
    { ...session, sandbox_id: sandbox.id },
  );

  return createSessionStreamResponse(result, auth.tenantId, session.id, effectiveBudget, {
    prelude: [JSON.stringify({
      type: "session_created",
      session_id: session.id,
      agent_id: session.agent_id,
      timestamp: new Date().toISOString(),
    })],
  });
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;

  const sessions = await listSessions(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  const responseSessions = sessions.map((s) => SessionResponseRow.parse(s));
  return jsonResponse({ data: responseSessions, limit: pagination.limit, offset: pagination.offset });
});
