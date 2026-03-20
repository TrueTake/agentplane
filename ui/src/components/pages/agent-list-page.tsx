"use client";

import { useState, useCallback } from "react";
import { useSWRConfig } from "swr";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { useNavigation } from "../../hooks/use-navigation";
import { useApi } from "../../hooks/use-api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { FormField } from "../ui/form-field";
import { FormError } from "../ui/form-error";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "../ui/admin-table";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "../ui/dialog";
import { ModelSelector } from "../ui/model-selector";
import { supportsClaudeRunner } from "../../utils";

interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  model: string;
  permission_mode: string;
  composio_toolkits: string[];
  max_turns: number;
  max_budget_usd: number;
  a2a_enabled: boolean;
  skills: unknown[];
  plugins: unknown[];
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Add Agent Dialog                                                    */
/* ------------------------------------------------------------------ */

function AddAgentDialog({ onCreated }: { onCreated: () => void }) {
  const client = useAgentPlaneClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    description: "",
    model: "claude-sonnet-4-6",
    runner: "" as string,
    permission_mode: "bypassPermissions",
    max_turns: "100",
    max_budget_usd: "1.00",
    max_runtime_minutes: "10",
  });

  function resetForm() {
    setForm({
      name: "",
      description: "",
      model: "claude-sonnet-4-6",
      runner: "",
      permission_mode: "bypassPermissions",
      max_turns: "100",
      max_budget_usd: "1.00",
      max_runtime_minutes: "10",
    });
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await client.agents.create({
        name: form.name,
        description: form.description || null,
        model: form.model,
        runner: form.runner || null,
        permission_mode: form.permission_mode,
        max_turns: parseInt(form.max_turns),
        max_budget_usd: parseFloat(form.max_budget_usd),
        max_runtime_seconds: parseInt(form.max_runtime_minutes) * 60,
      });
      setOpen(false);
      resetForm();
      onCreated();
    } catch (err: any) {
      setError(err?.message ?? "Failed to create agent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>+ New Agent</Button>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Add Agent</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <FormField label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="my-agent"
                  required
                />
              </FormField>
              <FormField label="Description">
                <Input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What does this agent do?"
                />
              </FormField>
              <FormField label="Model">
                <ModelSelector
                  value={form.model}
                  onChange={(modelId) => setForm((f) => ({
                    ...f,
                    model: modelId,
                    runner: supportsClaudeRunner(modelId) ? f.runner : "vercel-ai-sdk",
                    permission_mode: supportsClaudeRunner(modelId) ? f.permission_mode : "bypassPermissions",
                  }))}
                />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Runner">
                  {supportsClaudeRunner(form.model) ? (
                    <Select
                      value={form.runner || "claude-agent-sdk"}
                      onChange={(e) => setForm((f) => ({ ...f, runner: e.target.value === "claude-agent-sdk" ? "" : e.target.value }))}
                    >
                      <option value="claude-agent-sdk">Claude Agent SDK</option>
                      <option value="vercel-ai-sdk">Vercel AI SDK</option>
                    </Select>
                  ) : (
                    <Select value="vercel-ai-sdk" disabled>
                      <option value="vercel-ai-sdk">Vercel AI SDK</option>
                    </Select>
                  )}
                </FormField>
                <FormField label="Permission Mode">
                  <Select
                    value={form.permission_mode}
                    onChange={(e) => setForm((f) => ({ ...f, permission_mode: e.target.value }))}
                    disabled={!supportsClaudeRunner(form.model) || form.runner === "vercel-ai-sdk"}
                  >
                    <option value="default">default</option>
                    <option value="acceptEdits">acceptEdits</option>
                    <option value="bypassPermissions">bypassPermissions</option>
                    <option value="plan">plan</option>
                  </Select>
                </FormField>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Max Turns">
                  <Input
                    type="number"
                    min="1"
                    max="1000"
                    value={form.max_turns}
                    onChange={(e) => setForm((f) => ({ ...f, max_turns: e.target.value }))}
                    required
                  />
                </FormField>
                <FormField label="Max Budget">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100"
                      value={form.max_budget_usd}
                      onChange={(e) => setForm((f) => ({ ...f, max_budget_usd: e.target.value }))}
                      className="pl-6"
                      required
                    />
                  </div>
                </FormField>
                <FormField label="Max Runtime">
                  <div className="relative">
                    <Input
                      type="number"
                      min="1"
                      max="60"
                      value={form.max_runtime_minutes}
                      onChange={(e) => setForm((f) => ({ ...f, max_runtime_minutes: e.target.value }))}
                      className="pr-10"
                      required
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">min</span>
                  </div>
                </FormField>
              </div>
              <FormError error={error} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Creating..." : "Create Agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Delete Agent Button                                                */
/* ------------------------------------------------------------------ */

function DeleteAgentButton({ agentId, agentName, onDeleted }: { agentId: string; agentName: string; onDeleted: () => void }) {
  const client = useAgentPlaneClient();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await client.agents.delete(agentId);
      setOpen(false);
      onDeleted();
    } catch (err: any) {
      setError(err?.message ?? "Failed to delete agent");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive text-xs"
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete Agent"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={error}
        onConfirm={handleDelete}
      >
        Delete <span className="font-medium text-foreground">{agentName}</span>? This will also remove all associated runs and connections.
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Agent List Page                                                     */
/* ------------------------------------------------------------------ */

export function AgentListPage() {
  const { LinkComponent, basePath } = useNavigation();
  const { mutate } = useSWRConfig();

  const { data, error, isLoading } = useApi<{ data: Agent[] }>(
    "agents",
    (client) => client.agents.list() as Promise<{ data: Agent[] }>,
  );

  const agents: Agent[] = data?.data ?? [];

  const invalidate = useCallback(() => {
    mutate("agents");
  }, [mutate]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-32" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive text-sm py-12 text-center">
        Failed to load agents: {error.message}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center mb-6">
        <AddAgentDialog onCreated={invalidate} />
      </div>
      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Description</Th>
          <Th>Model</Th>
          <Th>Connectors</Th>
          <Th align="right">Skills</Th>
          <Th align="right">Plugins</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {agents.map((a) => (
            <AdminTableRow key={a.id}>
              <td className="p-3 font-medium">
                <div className="flex items-center gap-2">
                  <LinkComponent href={`${basePath}/agents/${a.id}`} className="text-primary hover:underline">
                    {a.name}
                  </LinkComponent>
                  {a.a2a_enabled && (
                    <Badge className="text-[10px] px-1.5 py-0 bg-indigo-500/10 text-indigo-400 border-indigo-500/20">A2A</Badge>
                  )}
                </div>
              </td>
              <td className="p-3 text-muted-foreground text-xs max-w-xs truncate" title={a.description ?? undefined}>
                {a.description ?? "\u2014"}
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">{a.model}</td>
              <td className="p-3">
                {a.composio_toolkits.length > 0 ? (
                  <div className="flex gap-1 flex-wrap">
                    {a.composio_toolkits.map((t) => (
                      <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-xs">{"\u2014"}</span>
                )}
              </td>
              <td className="p-3 text-right">{(a.skills ?? []).length}</td>
              <td className="p-3 text-right">{(a.plugins ?? []).length}</td>
              <td className="p-3 text-right">
                <DeleteAgentButton agentId={a.id} agentName={a.name} onDeleted={invalidate} />
              </td>
            </AdminTableRow>
          ))}
          {agents.length === 0 && <EmptyRow colSpan={7}>No agents found</EmptyRow>}
        </tbody>
      </AdminTable>
    </div>
  );
}
