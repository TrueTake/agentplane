"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { useNavigation } from "../../hooks/use-navigation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "../ui/admin-table";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "../ui/dialog";
import { FormField } from "../ui/form-field";
import { FormError } from "../ui/form-error";
import { Skeleton } from "../ui/skeleton";

interface Marketplace {
  id: string;
  name: string;
  github_repo: string;
  created_at: string;
  agent_count: number;
  is_owned: boolean;
}

export interface PluginMarketplaceListPageProps {
  initialData?: Marketplace[];
}

export function PluginMarketplaceListPage({ initialData }: PluginMarketplaceListPageProps) {
  const { mutate } = useSWRConfig();
  const client = useAgentPlaneClient();
  const { LinkComponent, basePath } = useNavigation();

  const { data: marketplaces, error, isLoading } = useApi<Marketplace[]>(
    "plugin-marketplaces",
    (c) => c.pluginMarketplaces.list() as Promise<Marketplace[]>,
    initialData ? { fallbackData: initialData } : undefined,
  );

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newMarketplace, setNewMarketplace] = useState({ name: "", github_repo: "" });

  const [deleteTarget, setDeleteTarget] = useState<Marketplace | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  function resetAddForm() {
    setNewMarketplace({ name: "", github_repo: "" });
    setAddError("");
  }

  async function handleAdd() {
    setAdding(true);
    setAddError("");
    try {
      await client.pluginMarketplaces.create(newMarketplace);
      setShowAdd(false);
      resetAddForm();
      mutate("plugin-marketplaces");
    } catch (err: any) {
      setAddError(err?.message ?? "Failed to add marketplace");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await client.pluginMarketplaces.delete(deleteTarget.id);
      setDeleteTarget(null);
      mutate("plugin-marketplaces");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load marketplaces: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !marketplaces) {
    return <Skeleton className="h-96 rounded-lg" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center">
        <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
          + Add Marketplace
        </Button>
      </div>

      <Dialog open={showAdd} onOpenChange={(v) => { setShowAdd(v); if (!v) resetAddForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Marketplace</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <FormField label="Name">
              <Input
                value={newMarketplace.name}
                onChange={(e) => setNewMarketplace({ ...newMarketplace, name: e.target.value })}
                placeholder="My Marketplace"
              />
            </FormField>
            <FormField label="GitHub Repo">
              <Input
                value={newMarketplace.github_repo}
                onChange={(e) => setNewMarketplace({ ...newMarketplace, github_repo: e.target.value })}
                placeholder="owner/repo"
              />
            </FormField>
            <FormError error={addError} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); resetAddForm(); }}>Cancel</Button>
            <Button size="sm" onClick={handleAdd} disabled={adding || !newMarketplace.name || !newMarketplace.github_repo}>
              {adding ? "Adding..." : "Add Marketplace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>GitHub Repo</Th>
          <Th align="right">Agents Using</Th>
          <Th>Added</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {marketplaces.map((m) => (
            <AdminTableRow key={m.id}>
              <td className="p-3 font-medium">
                <LinkComponent
                  href={`${basePath}/plugin-marketplaces/${m.id}`}
                  className="text-primary hover:underline"
                >
                  {m.name}
                </LinkComponent>
                {m.is_owned && (
                  <Badge variant="secondary" className="ml-2 text-xs">Owned</Badge>
                )}
              </td>
              <td className="p-3">
                <a
                  href={`https://github.com/${m.github_repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {m.github_repo}
                </a>
              </td>
              <td className="p-3 text-right">
                <Badge variant={m.agent_count > 0 ? "default" : "secondary"}>
                  {m.agent_count}
                </Badge>
              </td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(m.created_at).toLocaleDateString()}
              </td>
              <td className="p-3 text-right">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={m.agent_count > 0}
                  onClick={() => setDeleteTarget(m)}
                >
                  Delete
                </Button>
              </td>
            </AdminTableRow>
          ))}
          {marketplaces.length === 0 && (
            <EmptyRow colSpan={5}>
              No plugin marketplaces registered. Click &quot;Add Marketplace&quot; to add one.
            </EmptyRow>
          )}
        </tbody>
      </AdminTable>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteError(""); } }}
        title="Delete Marketplace"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
      >
        Delete marketplace <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
