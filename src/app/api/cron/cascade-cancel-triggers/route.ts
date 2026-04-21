// Drains webhook_triggers rows marked pending_cancel, retiring each Composio
// subscription upstream before removing the DB row. Claim uses FOR UPDATE SKIP
// LOCKED so concurrent cron invocations don't double-process.
//
// Retry posture (per plan Unit 8):
//   - After a failed attempt, wait 10 minutes before reclaiming the row.
//   - After 3 consecutive failed attempts, enter a 24-hour cooldown.
//   - At 10+ attempts the row is effectively terminal — it re-enters the claim
//     pool after 24h but an ERROR-level "manual intervention required" marker
//     lets ops notice. We don't auto-drop, since deleting the row would lose
//     the composio_trigger_id needed to eventually clean up upstream.

import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getPool } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { deleteTrigger as composioDeleteTrigger } from "@/lib/composio-triggers";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLAIM_LIMIT = 50;
const CONCURRENCY = 10;
const MAX_ATTEMPTS_BEFORE_COOLDOWN = 3;
const MAX_ATTEMPTS_BEFORE_MANUAL = 10;

const ClaimedRow = z.object({
  id: z.string(),
  composio_trigger_id: z.string(),
  cancel_attempts: z.coerce.number(),
});
type ClaimedRow = z.infer<typeof ClaimedRow>;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const pool = getPool();
  const client = await pool.connect();
  let claimed: ClaimedRow[] = [];

  try {
    await client.query("BEGIN");
    // Claim up to CLAIM_LIMIT rows where:
    //   - pending_cancel is true
    //   - last attempt was either >10min ago (normal retry) or >24h ago (post-cooldown).
    //   - OR never attempted (NULL).
    // SKIP LOCKED keeps concurrent cron invocations from claiming the same rows.
    const res = await client.query(
      `SELECT id, composio_trigger_id, cancel_attempts
       FROM webhook_triggers
       WHERE pending_cancel = true
         AND (
           last_cancel_attempt_at IS NULL
           OR (cancel_attempts < $1 AND last_cancel_attempt_at < NOW() - INTERVAL '10 minutes')
           OR (cancel_attempts >= $1 AND last_cancel_attempt_at < NOW() - INTERVAL '24 hours')
         )
       ORDER BY last_cancel_attempt_at ASC NULLS FIRST
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS_BEFORE_COOLDOWN, CLAIM_LIMIT],
    );
    claimed = res.rows.map((r: unknown) => ClaimedRow.parse(r));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (claimed.length === 0) {
    return jsonResponse({ processed: 0, deleted: 0, failed: 0 });
  }

  let deleted = 0;
  let failed = 0;

  // Bounded-concurrency worker pool.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) break;
      try {
        const { alreadyGone } = await composioDeleteTrigger(row.composio_trigger_id);
        // Success (or 404 already-gone): delete the row; cascade cleans deliveries.
        await pool.query("DELETE FROM webhook_triggers WHERE id = $1", [row.id]);
        deleted++;
        if (alreadyGone) {
          logger.info("cascade-cancel: trigger already gone upstream", {
            trigger_id: row.id,
            composio_trigger_id: row.composio_trigger_id,
          });
        }
      } catch (err) {
        failed++;
        const nextAttempts = row.cancel_attempts + 1;
        await pool.query(
          `UPDATE webhook_triggers
           SET last_cancel_attempt_at = NOW(),
               cancel_attempts = $1
           WHERE id = $2`,
          [nextAttempts, row.id],
        );
        const level = nextAttempts >= MAX_ATTEMPTS_BEFORE_MANUAL
          ? "error"
          : nextAttempts >= MAX_ATTEMPTS_BEFORE_COOLDOWN
            ? "error"
            : "warn";
        const message = nextAttempts >= MAX_ATTEMPTS_BEFORE_MANUAL
          ? "cascade-cancel: manual intervention required"
          : "cascade-cancel: delete failed, will retry";
        logger[level](message, {
          trigger_id: row.id,
          composio_trigger_id: row.composio_trigger_id,
          attempts: nextAttempts,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  await Promise.all(workers);

  logger.info("cascade-cancel sweep complete", {
    processed: claimed.length,
    deleted,
    failed,
  });

  return jsonResponse({ processed: claimed.length, deleted, failed });
});
