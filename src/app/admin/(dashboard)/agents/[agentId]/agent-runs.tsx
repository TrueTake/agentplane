import Link from "next/link";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { RunSourceBadge } from "@/components/ui/run-source-badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { LocalDate } from "@/components/local-date";
import { query } from "@/db";
import { RunTriggeredBySchema } from "@/lib/validation";
import { z } from "zod";

const AgentRun = z.object({
  id: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  triggered_by: RunTriggeredBySchema.default("api"),
  error_type: z.string().nullable(),
  created_at: z.coerce.string(),
});

export async function AgentRuns({ agentId }: { agentId: string }) {
  const runs = await query(
    AgentRun,
    `SELECT id, status, prompt, cost_usd, num_turns, duration_ms,
       triggered_by, error_type, created_at
     FROM runs
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [agentId],
  );

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
              <Link href={`/admin/runs/${r.id}`} className="text-primary hover:underline">
                {r.id.slice(0, 8)}...
              </Link>
            </td>
            <td className="p-3"><RunStatusBadge status={r.status} /></td>
            <td className="p-3"><RunSourceBadge triggeredBy={r.triggered_by} /></td>
            <td className="p-3 max-w-xs truncate text-muted-foreground text-xs" title={r.prompt}>
              {r.prompt.slice(0, 80)}{r.prompt.length > 80 ? "..." : ""}
            </td>
            <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
            <td className="p-3 text-right">{r.num_turns}</td>
            <td className="p-3 text-right text-muted-foreground text-xs">
              {r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
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
