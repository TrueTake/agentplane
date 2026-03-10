import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionResponseRow } from "@/lib/validation";
import { getSession, stopSession } from "@/lib/sessions";
import { listRuns } from "@/lib/runs";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  const session = await getSession(sessionId, auth.tenantId);
  const responseSession = SessionResponseRow.parse(session);

  // Filter runs by session_id at DB level (#024)
  const sessionRuns = await listRuns(auth.tenantId, {
    sessionId,
    limit: 100,
    offset: 0,
  });

  return jsonResponse({ ...responseSession, runs: sessionRuns });
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  const session = await getSession(sessionId, auth.tenantId);

  // Stop sandbox if alive (session file was already backed up after last message)
  if (session.sandbox_id) {
    try {
      const sandbox = await reconnectSandbox(session.sandbox_id);
      if (sandbox) await sandbox.stop();
    } catch (err) {
      logger.warn("Failed to stop sandbox during session delete", {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stopped = await stopSession(sessionId, auth.tenantId);
  return jsonResponse(SessionResponseRow.parse(stopped));
});
