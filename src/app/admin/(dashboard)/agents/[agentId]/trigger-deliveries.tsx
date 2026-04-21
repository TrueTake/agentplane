"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { LocalDate } from "@/components/local-date";
import { FormError } from "@/components/ui/form-error";
import { adminFetch } from "@/app/admin/lib/api";
import type { WebhookDeliveryStatus } from "@/lib/types";

interface DeliveryRow {
  id: string;
  composio_event_id: string;
  received_at: string;
  status: WebhookDeliveryStatus;
  run_id: string | null;
  payload_truncated: boolean;
  payload_preview: string | null;
}

interface DeliveriesResponse {
  items: DeliveryRow[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 25;
const PREVIEW_CLIP = 200;

function statusVariant(status: WebhookDeliveryStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "accepted":
      return "default";
    case "filtered":
    case "trigger_disabled":
      return "secondary";
    case "rejected_429":
    case "signature_failed":
    case "budget_blocked":
    case "run_failed_to_create":
      return "destructive";
    default:
      return "outline";
  }
}

export function TriggerDeliveries({ agentId, triggerId }: { agentId: string; triggerId: string }) {
  const [data, setData] = useState<DeliveriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const resp = await adminFetch<DeliveriesResponse>(
          `/agents/${agentId}/triggers/${triggerId}/deliveries?limit=${PAGE_SIZE}&offset=${nextOffset}`,
        );
        setData(resp);
        setOffset(nextOffset);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load deliveries");
      } finally {
        setLoading(false);
      }
    },
    [agentId, triggerId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="rounded border border-muted-foreground/15 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Delivery log</h3>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load(offset)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      <FormError error={error} />

      {!data && !error && <p className="text-xs text-muted-foreground">Loading deliveries...</p>}

      {data && data.items.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">No deliveries yet.</p>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-2 pr-3">Status</th>
                  <th className="text-left py-2 pr-3">Received</th>
                  <th className="text-left py-2 pr-3">Envelope</th>
                  <th className="text-left py-2 pr-3">Run</th>
                  <th className="text-left py-2 pr-3">Preview</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const isExpanded = expanded[row.id] ?? false;
                  const preview = row.payload_preview ?? "";
                  const shouldClip = preview.length > PREVIEW_CLIP;
                  const shown = isExpanded || !shouldClip ? preview : `${preview.slice(0, PREVIEW_CLIP)}…`;
                  const envShort = row.composio_event_id.length > 12
                    ? `${row.composio_event_id.slice(0, 8)}…${row.composio_event_id.slice(-4)}`
                    : row.composio_event_id;

                  return (
                    <tr key={row.id} className="border-b border-border/50 align-top">
                      <td className="py-2 pr-3">
                        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                        <LocalDate value={row.received_at} />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1">
                          <code className="text-xs font-mono">{envShort}</code>
                          <CopyButton text={row.composio_event_id} />
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        {row.run_id ? (
                          <Link
                            href={`/admin/runs/${row.run_id}`}
                            className="text-xs text-primary hover:underline font-mono"
                          >
                            {row.run_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 max-w-md">
                        {preview ? (
                          <>
                            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground font-mono">
                              {shown}
                            </pre>
                            {shouldClip && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpanded((prev) => ({ ...prev, [row.id]: !isExpanded }))
                                }
                                className="text-xs text-primary hover:underline mt-1"
                              >
                                {isExpanded ? "Show less" : "Show full"}
                              </button>
                            )}
                            {row.payload_truncated && (
                              <p className="text-xs text-muted-foreground italic mt-1">
                                (payload truncated at ingest)
                              </p>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <span>
              {total} total · Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
                disabled={loading || offset === 0}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void load(offset + PAGE_SIZE)}
                disabled={loading || offset + PAGE_SIZE >= total}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
