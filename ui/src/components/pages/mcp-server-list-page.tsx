"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "../ui/admin-table";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Skeleton } from "../ui/skeleton";

interface McpServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  base_url: string;
  mcp_endpoint_path: string;
  client_id: string | null;
  created_at: string;
  connection_count: number;
  active_count: number;
}

export interface McpServerListPageProps {
  initialData?: McpServer[];
}

export function McpServerListPage({ initialData }: McpServerListPageProps) {
  const { mutate } = useSWRConfig();
  const client = useAgentPlaneClient();

  const { data: servers, error, isLoading } = useApi<McpServer[]>(
    "mcp-servers",
    (c) => c.customConnectors.listServers() as Promise<McpServer[]>,
    initialData ? { fallbackData: initialData } : undefined,
  );

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newServer, setNewServer] = useState({ name: "", slug: "", description: "", base_url: "", mcp_endpoint_path: "/mcp" });

  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function handleAdd() {
    setAdding(true);
    try {
      await client.customConnectors.createServer!(newServer);
      setShowAdd(false);
      setNewServer({ name: "", slug: "", description: "", base_url: "", mcp_endpoint_path: "/mcp" });
      mutate("mcp-servers");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await client.customConnectors.deleteServer!(deleteTarget.id);
      setDeleteTarget(null);
      mutate("mcp-servers");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load MCP servers: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !servers) {
    return <Skeleton className="h-96 rounded-lg" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center">
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "Register Connector"}
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Name" value={newServer.name} onChange={(e) => setNewServer({ ...newServer, name: e.target.value })} />
            <Input placeholder="Slug" value={newServer.slug} onChange={(e) => setNewServer({ ...newServer, slug: e.target.value })} />
            <Input placeholder="Description" value={newServer.description} onChange={(e) => setNewServer({ ...newServer, description: e.target.value })} />
            <Input placeholder="Base URL" value={newServer.base_url} onChange={(e) => setNewServer({ ...newServer, base_url: e.target.value })} />
            <Input placeholder="MCP Endpoint Path" value={newServer.mcp_endpoint_path} onChange={(e) => setNewServer({ ...newServer, mcp_endpoint_path: e.target.value })} />
          </div>
          <Button size="sm" onClick={handleAdd} disabled={adding || !newServer.name || !newServer.base_url}>
            {adding ? "Adding..." : "Add Server"}
          </Button>
        </div>
      )}

      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Slug</Th>
          <Th>Base URL</Th>
          <Th>OAuth</Th>
          <Th align="right">Connections</Th>
          <Th align="right">Active</Th>
          <Th>Created</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {servers.map((s) => (
            <AdminTableRow key={s.id}>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  {s.logo_url && (
                    <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain" />
                  )}
                  <span className="font-medium">{s.name}</span>
                </div>
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">{s.slug}</td>
              <td className="p-3 font-mono text-xs text-muted-foreground truncate max-w-xs" title={s.base_url}>
                {s.base_url}
              </td>
              <td className="p-3">
                <Badge variant={s.client_id ? "default" : "secondary"}>
                  {s.client_id ? "Registered" : "No DCR"}
                </Badge>
              </td>
              <td className="p-3 text-right">{s.connection_count}</td>
              <td className="p-3 text-right text-green-500">{s.active_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(s.created_at).toLocaleDateString()}
              </td>
              <td className="p-3 text-right">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={s.connection_count > 0}
                  onClick={() => setDeleteTarget(s)}
                >
                  Delete
                </Button>
              </td>
            </AdminTableRow>
          ))}
          {servers.length === 0 && (
            <EmptyRow colSpan={8}>
              No custom connectors registered. Click &quot;Register Connector&quot; to add one.
            </EmptyRow>
          )}
        </tbody>
      </AdminTable>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteError(""); } }}
        title="Delete Server"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
      >
        Delete MCP server <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
