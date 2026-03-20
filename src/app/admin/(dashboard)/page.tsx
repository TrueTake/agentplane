import Link from "next/link";
import { MetricCard } from "@/components/ui/metric-card";
import { query, queryOne } from "@/db";
import { z } from "zod";
import { RunCharts, type DailyAgentStat } from "./run-charts";
import { getActiveTenantId } from "@/lib/active-tenant";

export const dynamic = "force-dynamic";

const StatsRow = z.object({
  agent_count: z.coerce.number(),
  total_runs: z.coerce.number(),
  active_runs: z.coerce.number(),
  total_spend: z.coerce.number(),
});

const DailyStatRow = z.object({
  date: z.string(),
  agent_name: z.string(),
  run_count: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

export default async function AdminDashboardPage() {
  const tenantId = (await getActiveTenantId()) ?? null;

  if (!tenantId) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-muted-foreground">Select a company from the sidebar to view the dashboard.</p>
      </div>
    );
  }

  const [stats, dailyStats] = await Promise.all([
    queryOne(
      StatsRow,
      `SELECT
         (SELECT COUNT(*) FROM agents WHERE tenant_id = $1)::int AS agent_count,
         (SELECT COUNT(*) FROM runs WHERE tenant_id = $1)::int AS total_runs,
         (SELECT COUNT(*) FROM runs WHERE tenant_id = $1 AND status = 'running')::int AS active_runs,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE tenant_id = $1) AS total_spend`,
      [tenantId],
    ),
    query(
      DailyStatRow,
      `SELECT
         DATE(r.created_at)::text AS date,
         a.name AS agent_name,
         COUNT(*)::int AS run_count,
         COALESCE(SUM(r.cost_usd), 0) AS cost_usd
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       WHERE r.tenant_id = $1 AND r.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(r.created_at), a.name
       ORDER BY date ASC`,
      [tenantId],
    ),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Agents">
          {stats?.agent_count ?? 0}
        </MetricCard>
        <Link href="/admin/runs" className="block">
          <MetricCard label="Total Runs" className="hover:bg-muted/30 transition-colors cursor-pointer h-full">
            {stats?.total_runs ?? 0}
          </MetricCard>
        </Link>
        <MetricCard label="Active Runs">
          <span className="text-green-500">{stats?.active_runs ?? 0}</span>
        </MetricCard>
        <MetricCard label="Total Spend">
          <span className="font-mono">${(stats?.total_spend ?? 0).toFixed(2)}</span>
        </MetricCard>
      </div>

      <RunCharts stats={dailyStats as DailyAgentStat[]} />
    </div>
  );
}
