"use client";

import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { MetricCard } from "../ui/metric-card";
import { Skeleton } from "../ui/skeleton";
import type { DailyAgentStat } from "./run-charts";

interface DashboardStats {
  agent_count: number;
  total_runs: number;
  active_runs: number;
  total_spend: number;
  session_count: number;
}

interface DashboardData {
  stats: DashboardStats;
  daily_stats: DailyAgentStat[];
}

export interface DashboardPageProps {
  /** Optional initial data for SSR/RSC hosts */
  initialData?: DashboardData;
  /** Optional chart component — pass RunCharts from @getcatalystiq/agent-plane-ui/charts */
  chartComponent?: React.ComponentType<{ stats: DailyAgentStat[] }>;
}

export function DashboardPage({ initialData, chartComponent: ChartComponent }: DashboardPageProps) {
  const { LinkComponent, basePath } = useNavigation();

  const { data, error, isLoading } = useApi<DashboardData>(
    "dashboard",
    async (client) => {
      const [stats, daily_stats] = await Promise.all([
        client.dashboard.stats() as Promise<DashboardStats>,
        client.dashboard.charts() as Promise<DailyAgentStat[]>,
      ]);
      return { stats, daily_stats };
    },
    initialData ? { fallbackData: initialData } : undefined,
  );

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load dashboard: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  const { stats, daily_stats } = data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Agents">
          {stats.agent_count}
        </MetricCard>
        <LinkComponent href={`${basePath}/runs`} className="block">
          <MetricCard label="Total Runs" className="hover:bg-muted/30 transition-colors cursor-pointer h-full">
            {stats.total_runs}
          </MetricCard>
        </LinkComponent>
        <MetricCard label="Active Runs">
          <span className="text-green-500">{stats.active_runs}</span>
        </MetricCard>
        <MetricCard label="Total Spend">
          <span className="font-mono">${stats.total_spend.toFixed(2)}</span>
        </MetricCard>
      </div>

      {ChartComponent && <ChartComponent stats={daily_stats} />}
    </div>
  );
}
