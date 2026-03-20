import Link from "next/link";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { RunSourceBadge } from "@/components/ui/run-source-badge";
import { SourceFilter } from "./source-filter";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { LocalDate } from "@/components/local-date";
import { query, queryOne } from "@/db";
import { RunTriggeredBySchema } from "@/lib/validation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { z } from "zod";

const RunWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  triggered_by: RunTriggeredBySchema.default("api"),
  error_type: z.string().nullable(),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

export const dynamic = "force-dynamic";

const VALID_SOURCES = ["api", "schedule", "playground", "chat", "a2a"] as const;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; source?: string }>;
}) {
  const tenantId = (await getActiveTenantId()) ?? null;
  if (!tenantId) {
    return (
      <div className="text-muted-foreground text-sm py-12 text-center">
        Select a tenant from the sidebar.
      </div>
    );
  }

  const { page: pageParam, pageSize: pageSizeParam, source: sourceParam } = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(pageParam, pageSizeParam);
  const sourceFilter = VALID_SOURCES.includes(sourceParam as typeof VALID_SOURCES[number])
    ? (sourceParam as typeof VALID_SOURCES[number])
    : null;

  const sourceWhere = sourceFilter
    ? `WHERE r.tenant_id = $3 AND r.triggered_by = $4`
    : `WHERE r.tenant_id = $3`;
  const sourceWhereCount = sourceFilter
    ? `WHERE r.tenant_id = $1 AND r.triggered_by = $2`
    : `WHERE r.tenant_id = $1`;
  const params = sourceFilter
    ? [pageSize, offset, tenantId, sourceFilter]
    : [pageSize, offset, tenantId];

  const [runs, countResult] = await Promise.all([
    query(
      RunWithContext,
      `SELECT r.id, r.agent_id, a.name AS agent_name, r.tenant_id,
         r.status, r.triggered_by, r.prompt, r.cost_usd, r.num_turns, r.duration_ms,
         r.total_input_tokens, r.total_output_tokens, r.error_type,
         r.started_at, r.completed_at, r.created_at
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       ${sourceWhere}
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    ),
    queryOne(
      z.object({ total: z.number() }),
      `SELECT COUNT(*)::int AS total FROM runs r
       JOIN agents a ON a.id = r.agent_id
       ${sourceWhereCount}`,
      sourceFilter ? [tenantId, sourceFilter] : [tenantId],
    ),
  ]);

  const total = countResult?.total ?? 0;

  return (
    <div>
      <div className="flex items-center mb-6">
        <SourceFilter current={sourceFilter} />
      </div>
      <AdminTable className="overflow-x-auto" footer={
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p, ps) => `/admin/runs?page=${p}&pageSize=${ps}${sourceFilter ? `&source=${sourceFilter}` : ""}`}
        />
      }>
        <AdminTableHead>
          <Th>Run</Th>
          <Th>Agent</Th>
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
              <td className="p-3 text-xs">{r.agent_name}</td>
              <td className="p-3"><RunStatusBadge status={r.status} /></td>
              <td className="p-3">
                <RunSourceBadge triggeredBy={r.triggered_by} />
              </td>
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
          {runs.length === 0 && <EmptyRow colSpan={9}>No runs found</EmptyRow>}
        </tbody>
      </AdminTable>
    </div>
  );
}
