"use client";

import { Fragment, useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { FormError } from "@/components/ui/form-error";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LocalDate } from "@/components/local-date";
import { adminFetch } from "@/app/admin/lib/api";
import type { WebhookTrigger } from "@/lib/webhook-triggers";
import { TriggerEditor } from "./trigger-editor";
import { TriggerDeliveries } from "./trigger-deliveries";

interface TriggersTabProps {
  agentId: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  availableToolkits: string[];
  initialTriggers: WebhookTrigger[];
}

function statusPill(trigger: WebhookTrigger) {
  if (trigger.pending_cancel) {
    return <Badge variant="secondary">Pending cancel</Badge>;
  }
  if (trigger.enabled) {
    return <Badge variant="default">Enabled</Badge>;
  }
  return <Badge variant="outline">Disabled</Badge>;
}

export function TriggersTab({
  agentId,
  permissionMode,
  availableToolkits,
  initialTriggers,
}: TriggersTabProps) {
  const [triggers, setTriggers] = useState<WebhookTrigger[]>(initialTriggers);
  const [mode, setMode] = useState<"list" | "create" | { edit: string }>("list");
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookTrigger | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const isPlanMode = permissionMode === "plan";

  const refetch = useCallback(async () => {
    try {
      const rows = await adminFetch<WebhookTrigger[]>(`/agents/${agentId}/triggers`);
      setTriggers(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh triggers");
    }
  }, [agentId]);

  async function handleSaved() {
    setMode("list");
    await refetch();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await adminFetch(`/agents/${agentId}/triggers/${deleteTarget.id}`, {
        method: "DELETE",
      });
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5 space-y-4">
      <SectionHeader title="Triggers">
        {mode === "list" && (
          <Button
            size="sm"
            onClick={() => setMode("create")}
            disabled={isPlanMode || availableToolkits.length === 0}
            title={
              isPlanMode
                ? "Cannot create triggers on plan-mode agents — this mode never executes tools."
                : availableToolkits.length === 0
                  ? "Connect a toolkit to this agent first"
                  : undefined
            }
          >
            Add trigger
          </Button>
        )}
      </SectionHeader>

      <FormError error={error} />

      {isPlanMode && (
        <p className="text-xs text-muted-foreground">
          This agent is in plan mode. Triggers cannot be created until permission mode is
          changed — plan mode never executes tools.
        </p>
      )}

      {availableToolkits.length === 0 && !isPlanMode && (
        <p className="text-xs text-muted-foreground">
          No toolkits connected. Connect a toolkit via the Connectors tab before configuring triggers.
        </p>
      )}

      {mode === "create" && (
        <TriggerEditor
          agentId={agentId}
          availableToolkits={availableToolkits}
          isPlanMode={isPlanMode}
          onSaved={handleSaved}
          onCancel={() => setMode("list")}
        />
      )}

      {triggers.length === 0 && mode === "list" && (
        <p className="text-sm text-muted-foreground py-4">
          No triggers yet. Click &quot;Add trigger&quot; to configure one.
        </p>
      )}

      {triggers.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left py-2 pr-3">Status</th>
                <th className="text-left py-2 pr-3">Toolkit</th>
                <th className="text-left py-2 pr-3">Trigger type</th>
                <th className="text-left py-2 pr-3">Updated</th>
                <th className="text-left py-2 pr-3">Flags</th>
                <th className="text-right py-2 pl-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((trigger) => {
                const isExpanded = typeof mode === "object" && mode.edit === trigger.id;
                const zeroTools = trigger.tool_allowlist.length === 0;

                return (
                  <Fragment key={trigger.id}>
                    <tr className="border-b border-border/50 align-top">
                      <td className="py-2 pr-3">{statusPill(trigger)}</td>
                      <td className="py-2 pr-3 text-xs">{trigger.toolkit_slug}</td>
                      <td className="py-2 pr-3 text-xs font-mono">{trigger.trigger_type}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                        <LocalDate value={trigger.updated_at as unknown as string} />
                      </td>
                      <td className="py-2 pr-3 space-x-1">
                        {zeroTools && (
                          <Badge variant="destructive" className="bg-orange-600 hover:bg-orange-600">
                            No tools allowed
                          </Badge>
                        )}
                        {trigger.pending_cancel && (
                          <Badge variant="secondary">pending_cancel</Badge>
                        )}
                      </td>
                      <td className="py-2 pl-3 text-right space-x-2 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setMode(isExpanded ? "list" : { edit: trigger.id })
                          }
                          disabled={trigger.pending_cancel}
                        >
                          {isExpanded ? "Close" : "Edit"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setDeleteError(undefined);
                            setDeleteTarget(trigger);
                          }}
                          disabled={trigger.pending_cancel}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={6} className="py-3">
                          <div className="space-y-4">
                            <TriggerEditor
                              agentId={agentId}
                              availableToolkits={availableToolkits}
                              isPlanMode={isPlanMode}
                              initial={trigger}
                              onSaved={handleSaved}
                              onCancel={() => setMode("list")}
                            />
                            <TriggerDeliveries agentId={agentId} triggerId={trigger.id} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete trigger?"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={deleteError}
        onConfirm={confirmDelete}
      >
        This trigger will be marked for cancellation and stop receiving webhook events shortly.
        Already-received deliveries are preserved.
      </ConfirmDialog>
    </div>
  );
}
