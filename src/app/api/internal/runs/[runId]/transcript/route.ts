import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyRunToken } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { uploadTranscript } from "@/lib/transcripts";
import { transitionRunStatus } from "@/lib/runs";
import { parseResultEvent, NO_TERMINAL_EVENT_FALLBACK } from "@/lib/transcript-utils";
import { processLineAssets } from "@/lib/assets";
import { reconnectSessionSandboxForBackup } from "@/lib/sandbox";
import { finalizeSessionTail } from "@/lib/session-executor";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { RunId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

const RunRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  status: z.string(),
  session_id: z.string().nullable(),
  sandbox_id: z.string().nullable(),
  sdk_session_id: z.string().nullable(),
  max_budget_usd: z.coerce.number().optional(),
});

type RouteContext = { params: Promise<{ runId: string }> };

/**
 * Internal endpoint called by the sandbox runner to upload transcripts
 * for long-running or detached runs. Authenticated via HMAC-based run token.
 */
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { runId } = await (context as RouteContext).params;

  // Verify run token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: { code: "unauthorized", message: "Missing authorization" } }, 401);
  }
  const token = authHeader.slice(7);
  const env = getEnv();
  const valid = await verifyRunToken(token, runId, env.ENCRYPTION_KEY);
  if (!valid) {
    return jsonResponse({ error: { code: "unauthorized", message: "Invalid run token" } }, 401);
  }

  // Look up the run (with session join so we can run the session tail when
  // this run was triggered by a chat message)
  const run = await queryOne(
    RunRow,
    `SELECT r.id, r.tenant_id, r.status, r.session_id, a.max_budget_usd,
            s.sandbox_id, s.sdk_session_id
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
     LEFT JOIN sessions s ON s.id = r.session_id
     WHERE r.id = $1`,
    [runId],
  );
  if (!run) {
    return jsonResponse({ error: { code: "not_found", message: "Run not found" } }, 404);
  }
  if (run.status !== "running") {
    return jsonResponse({ error: { code: "conflict", message: `Run is ${run.status}, not running` } }, 409);
  }

  const tenantId = run.tenant_id as TenantId;
  const typedRunId = runId as RunId;

  // Read NDJSON body
  const body = await request.text();
  const lines = body.split("\n").filter((l) => l.trim());

  if (lines.length === 0) {
    return jsonResponse({ error: { code: "validation_error", message: "Empty transcript" } }, 400);
  }

  try {
    // Replace ephemeral asset URLs (e.g. Composio/R2) with permanent Blob URLs
    const processedLines = await Promise.all(
      lines.map((line) => processLineAssets(line, tenantId, typedRunId)),
    );
    const transcript = processedLines.join("\n") + "\n";
    const blobUrl = await uploadTranscript(tenantId, typedRunId, transcript);
    const resultData = (await parseResultEvent(lines[lines.length - 1])) ?? NO_TERMINAL_EVENT_FALLBACK;

    await transitionRunStatus(
      typedRunId,
      tenantId,
      "running",
      resultData.status,
      {
        completed_at: new Date().toISOString(),
        transcript_blob_url: blobUrl,
        ...resultData.updates,
      },
      { expectedMaxBudgetUsd: run.max_budget_usd },
    );

    logger.info("Internal transcript uploaded", { run_id: runId, lines: lines.length });

    // Session-tail: when a chat message run is finalized via the runner-driven
    // upload path (e.g. after the platform stream detached at 4.5 min), the
    // session is still pinned to "active" and the SDK session file is still
    // unbacked. Reconnect read-only to the sandbox, back up the file, and
    // flip the session active→idle. Best-effort — runErrors here must not
    // fail the run, which has already terminated.
    if (run.session_id && run.sandbox_id) {
      try {
        const sandbox = await reconnectSessionSandboxForBackup(run.sandbox_id);
        if (!sandbox) {
          logger.warn("Session sandbox gone before tail finalize; flipping session idle without backup", {
            run_id: runId,
            session_id: run.session_id,
            sandbox_id: run.sandbox_id,
          });
        }
        await finalizeSessionTail({
          runId: typedRunId,
          tenantId,
          sessionId: run.session_id,
          // If the sandbox is gone, finalizeSessionTail will skip the backup
          // (sdkSessionId becomes null) and just transition the session.
          sandbox: sandbox ?? ({
            // Stub: only used if sdkSessionId is non-null; we null it below.
          } as never),
          sdkSessionId: sandbox ? run.sdk_session_id : null,
        });
      } catch (tailErr) {
        logger.error("Session tail finalize from internal transcript route failed", {
          run_id: runId,
          session_id: run.session_id,
          error: tailErr instanceof Error ? tailErr.message : String(tailErr),
        });
      }
    }

    return jsonResponse({ status: "ok" });
  } catch (err) {
    logger.error("Internal transcript upload failed", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    await transitionRunStatus(typedRunId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "transcript_persist_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    return jsonResponse({ error: { code: "internal_error", message: "Failed to persist transcript" } }, 500);
  }
});
