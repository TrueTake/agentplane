// Daily TTL sweep for webhook_deliveries — R17 retention.
// Batched DELETE; at most 10 × 1000 rows per invocation so a long-running
// ingress burst can't tie up the cron forever. If had_more is true the next
// day's run picks up where we left off.

import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getPool } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const TTL_DAYS = 7;
const BATCH_SIZE = 1000;
const MAX_BATCHES = 10;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TTL_DAYS);

  const pool = getPool();
  let totalDeleted = 0;
  let hadMore = false;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const result = await pool.query(
      `DELETE FROM webhook_deliveries
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE received_at < $1
         LIMIT $2
       )`,
      [cutoff.toISOString(), BATCH_SIZE],
    );
    const affected = result.rowCount ?? 0;
    totalDeleted += affected;
    if (affected < BATCH_SIZE) {
      hadMore = false;
      break;
    }
    hadMore = true;
  }

  logger.info("Webhook delivery cleanup completed", {
    deleted: totalDeleted,
    cutoff: cutoff.toISOString(),
    had_more: hadMore,
  });

  return jsonResponse({
    deleted: totalDeleted,
    cutoff: cutoff.toISOString(),
    had_more: hadMore,
  });
});
