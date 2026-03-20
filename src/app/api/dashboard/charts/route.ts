import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query } from "@/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const DailyStatRow = z.object({
  date: z.string(),
  agent_name: z.string(),
  run_count: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

const ChartQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const url = new URL(request.url);
  const { days } = ChartQuerySchema.parse({
    days: url.searchParams.get("days"),
  });

  const dailyStats = await query(
    DailyStatRow,
    `SELECT
       DATE(r.created_at)::text AS date,
       a.name AS agent_name,
       COUNT(*)::int AS run_count,
       COALESCE(SUM(r.cost_usd), 0) AS cost_usd
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
     WHERE r.tenant_id = $1 AND r.created_at >= NOW() - make_interval(days => $2)
     GROUP BY DATE(r.created_at), a.name
     ORDER BY date ASC`,
    [auth.tenantId, days],
  );

  return jsonResponse({ data: dailyStats });
});
