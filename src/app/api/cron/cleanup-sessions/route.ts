import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute, query } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import {
  getIdleSessions,
  getStuckSessions,
  getExpiredSessions,
  getOrphanedSandboxSessions,
  type Session,
} from "@/lib/sessions";
import { deleteSessionFile } from "@/lib/session-files";
import { logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/cron-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CREATING_WATCHDOG_MINUTES = 5;
const ACTIVE_WATCHDOG_MINUTES = 30;

/**
 * Stop a sandbox by id, swallowing errors. Used in every sweep — sandbox API
 * failures must never block the row-level cleanup that keeps state consistent.
 */
async function stopSandboxBestEffort(
  sandboxId: string | null,
  context: { session_id: string; reason: string },
): Promise<void> {
  if (!sandboxId) return;
  try {
    const sandbox = await reconnectSandbox(sandboxId);
    if (sandbox) await sandbox.stop();
  } catch (err) {
    logger.warn("Failed to stop sandbox during cleanup", {
      ...context,
      sandbox_id: sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Force a session to `stopped`, regardless of current state, clearing
 * sandbox_id and idle_since. Returns the sandbox_id that was previously on
 * the row (so the caller can stop the sandbox once and only once).
 */
async function forceStop(sessionId: string): Promise<string | null> {
  const result = await query(
    z.object({ sandbox_id: z.string().nullable() }),
    `UPDATE sessions
     SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
     WHERE id = $1 AND status <> 'stopped'
     RETURNING sandbox_id`,
    [sessionId],
  );
  return result[0]?.sandbox_id ?? null;
}

/**
 * Mark the in-flight `running` message for a session as a watchdog terminal
 * status. Used by both creating-timeout and active-timeout watchdogs.
 */
async function markInFlightMessage(
  sessionId: string,
  toStatus: "failed" | "timed_out",
  errorType: string,
  errorMessage: string,
): Promise<void> {
  await execute(
    `UPDATE session_messages
     SET status = $2,
         completed_at = NOW(),
         error_type = $3,
         error_messages = ARRAY[$4]::text[]
     WHERE session_id = $1 AND status = 'running'`,
    [sessionId, toStatus, errorType, errorMessage],
  );
}

/**
 * Best-effort blob cleanup for terminal sessions. Persistent sessions back up
 * their SDK session JSON; on stop we remove that backup.
 */
async function cleanupBlob(session: Pick<Session, "session_blob_url">) {
  if (session.session_blob_url) {
    try {
      await deleteSessionFile(session.session_blob_url);
    } catch (err) {
      logger.warn("Failed to delete session blob", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  let expiredCleaned = 0;
  let idleCleaned = 0;
  let creatingWatchdog = 0;
  let activeWatchdog = 0;
  let orphansCleaned = 0;

  // 1. Expires_at sweep — stop sandboxes for any session past expires_at,
  //    regardless of state. Bounds the contextId-reuse warm-sandbox attack
  //    surface (4h wall-clock cap from creation).
  const expired = await getExpiredSessions();
  for (const session of expired) {
    try {
      const previousSandboxId = await forceStop(session.id);
      if (previousSandboxId) {
        await stopSandboxBestEffort(previousSandboxId, {
          session_id: session.id,
          reason: "expired",
        });
      }
      await markInFlightMessage(
        session.id,
        "timed_out",
        "session_expired",
        "Session exceeded 4h wall-clock cap; stopped by cleanup cron.",
      );
      await cleanupBlob(session);
      expiredCleaned++;
      logger.info("Expired session cleaned up", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        expires_at: session.expires_at,
        previous_status: session.status,
      });
    } catch (err) {
      logger.error("Failed to clean up expired session", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Idle-TTL sweep — sessions in `idle` past their per-row
  //    `idle_ttl_seconds`. Atomic CAS `idle → stopped` so we never race with
  //    a concurrent dispatcher `idle → active`.
  const idleSessions = await getIdleSessions();
  for (const session of idleSessions) {
    try {
      const cas = await query(
        z.object({ sandbox_id: z.string().nullable() }),
        `UPDATE sessions
         SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
         WHERE id = $1 AND status = 'idle'
         RETURNING sandbox_id`,
        [session.id],
      );
      if (cas.length === 0) {
        // Lost the race to a dispatcher idle→active; skip.
        continue;
      }
      const previousSandboxId = cas[0]?.sandbox_id ?? null;
      if (previousSandboxId) {
        await stopSandboxBestEffort(previousSandboxId, {
          session_id: session.id,
          reason: "idle_ttl",
        });
      }
      await cleanupBlob(session);
      idleCleaned++;
      logger.info("Idle session cleaned up", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        idle_since: session.idle_since,
        idle_ttl_seconds: session.idle_ttl_seconds,
      });
    } catch (err) {
      logger.error("Failed to clean up idle session", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Creating watchdog — sandbox boot timed out (>5 min in `creating`).
  const stuckCreating = await getStuckSessions("creating", CREATING_WATCHDOG_MINUTES);
  for (const session of stuckCreating) {
    try {
      const previousSandboxId = await forceStop(session.id);
      if (previousSandboxId) {
        await stopSandboxBestEffort(previousSandboxId, {
          session_id: session.id,
          reason: "creating_watchdog",
        });
      }
      await markInFlightMessage(
        session.id,
        "failed",
        "watchdog_creating_timeout",
        `Session stuck in 'creating' for >${CREATING_WATCHDOG_MINUTES} minutes.`,
      );
      await cleanupBlob(session);
      creatingWatchdog++;
      logger.warn("Creating-watchdog fired", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        created_at: session.created_at,
      });
    } catch (err) {
      logger.error("Failed creating-watchdog cleanup", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Active watchdog — runner crashed silently (>30 min in `active`).
  const stuckActive = await getStuckSessions("active", ACTIVE_WATCHDOG_MINUTES);
  for (const session of stuckActive) {
    try {
      const previousSandboxId = await forceStop(session.id);
      if (previousSandboxId) {
        await stopSandboxBestEffort(previousSandboxId, {
          session_id: session.id,
          reason: "active_watchdog",
        });
      }
      await markInFlightMessage(
        session.id,
        "timed_out",
        "watchdog_active_timeout",
        `Session stuck in 'active' for >${ACTIVE_WATCHDOG_MINUTES} minutes; runner presumed dead.`,
      );
      await cleanupBlob(session);
      activeWatchdog++;
      logger.warn("Active-watchdog fired", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        updated_at: session.updated_at,
      });
    } catch (err) {
      logger.error("Failed active-watchdog cleanup", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Orphan-sandbox sweep — terminal (`stopped`) sessions that still carry
  //    a non-null `sandbox_id`. With the unified schema sandboxes are tracked
  //    exclusively via `sessions.sandbox_id`; this is defense-in-depth for
  //    finalize paths that wrote `stopped` without clearing the column or
  //    couldn't reach the sandbox API at the time. The Vercel Sandbox SDK
  //    does not expose a global enumeration API — sandboxes that lost their
  //    DB row entirely will be reaped by the platform's own idle TTL.
  const orphaned = await getOrphanedSandboxSessions();
  for (const session of orphaned) {
    try {
      await stopSandboxBestEffort(session.sandbox_id, {
        session_id: session.id,
        reason: "orphan_sandbox",
      });
      await execute(
        `UPDATE sessions SET sandbox_id = NULL
         WHERE id = $1 AND status = 'stopped'`,
        [session.id],
      );
      orphansCleaned++;
      logger.info("Orphan sandbox stopped", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        sandbox_id: session.sandbox_id,
      });
    } catch (err) {
      logger.error("Failed orphan-sandbox cleanup", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const total = expiredCleaned + idleCleaned + creatingWatchdog + activeWatchdog + orphansCleaned;
  logger.info("Session cleanup completed", {
    expired_cleaned: expiredCleaned,
    idle_cleaned: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    orphans_cleaned: orphansCleaned,
    total,
  });

  return jsonResponse({
    cleaned: total,
    expired: expiredCleaned,
    idle: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    orphans: orphansCleaned,
  });
});
