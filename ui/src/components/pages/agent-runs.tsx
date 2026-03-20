"use client";

import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "../ui/admin-table";
import { Skeleton } from "../ui/skeleton";
import { RunStatusBadge } from "../ui/run-status-badge";
import { RunSourceBadge } from "../ui/run-source-badge";
import { LocalDate } from "../ui/local-date";

interface Run {
  id: string;
  status: string;
  prompt: string;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  triggered_by: string;
  error_type: string | null;
  created_at: string;
}

interface Props {
  agentId: string;
}

export function AgentRuns({ agentId }: Props) {
  const { LinkComponent, basePath } = useNavigation();

  const { data, error, isLoading } = useApi<{ data: Run[] }>(
    `agent-runs-${agentId}`,
    (client) => client.runs.list({ agent_id: agentId, limit: 50 }) as Promise<{ data: Run[] }>,
  );

  const runs: Run[] = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive text-sm py-4 text-center">
        Failed to load runs: {error.message}
      </div>
    );
  }

  return (
    <AdminTable>
      <AdminTableHead>
        <Th>Run</Th>
        <Th>Status</Th>
        <Th>Source</Th>
        <Th className="max-w-xs">Prompt</Th>
        <Th align="right">Cost</Th>
        <Th align="right">Turns</Th>
        <Th align="right">Duration</Th>
        <Th>Created</Th>
      </AdminTableHead>
      <tbody>
        {runs.map((r) => (
          <AdminTableRow key={r.id}>
            <td className="p-3 font-mono text-xs">
              <LinkComponent href={`${basePath}/runs/${r.id}`} className="text-primary hover:underline">
                {r.id.slice(0, 8)}...
              </LinkComponent>
            </td>
            <td className="p-3"><RunStatusBadge status={r.status} /></td>
            <td className="p-3"><RunSourceBadge triggeredBy={r.triggered_by} /></td>
            <td className="p-3 max-w-xs truncate text-muted-foreground text-xs" title={r.prompt}>
              {r.prompt.slice(0, 80)}{r.prompt.length > 80 ? "..." : ""}
            </td>
            <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
            <td className="p-3 text-right">{r.num_turns}</td>
            <td className="p-3 text-right text-muted-foreground text-xs">
              {r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "\u2014"}
            </td>
            <td className="p-3 text-muted-foreground text-xs">
              <LocalDate value={r.created_at} />
            </td>
          </AdminTableRow>
        ))}
        {runs.length === 0 && <EmptyRow colSpan={8}>No runs yet</EmptyRow>}
      </tbody>
    </AdminTable>
  );
}
