"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { ToolkitMultiselect } from "../ui/toolkit-multiselect";
import { SectionHeader } from "../ui/section-header";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { FormError } from "../ui/form-error";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from "../ui/dialog";

interface ConnectorStatus {
  slug: string;
  name: string;
  logo: string;
  auth_scheme: string;
  connected: boolean;
  connectionStatus?: string | null;
  authScheme: string;
}

interface McpConnection {
  id: string;
  mcp_server_id: string;
  status: string;
  allowed_tools: string[];
  token_expires_at: string | null;
  server_name: string;
  server_slug: string;
  server_logo_url: string | null;
  server_base_url: string;
}

interface McpServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  base_url: string;
}

interface Props {
  agentId: string;
  toolkits: string[];
  composioAllowedTools: string[];
  onChanged?: () => void;
}

function schemeBadgeVariant(scheme: string) {
  if (scheme === "NO_AUTH") return "secondary" as const;
  return "outline" as const;
}

function statusColor(status: string | null | undefined) {
  if (status === "ACTIVE") return "text-green-500";
  if (status === "INITIATED") return "text-yellow-500";
  if (status === "FAILED" || status === "EXPIRED" || status === "INACTIVE") return "text-destructive";
  return "text-muted-foreground";
}

/* ------------------------------------------------------------------ */
/*  Composio Tools Modal                                                */
/* ------------------------------------------------------------------ */

function ToolsModal({
  toolkit,
  toolkitLogo,
  allowedTools,
  open,
  onOpenChange,
  onSave,
}: {
  toolkit: string;
  toolkitLogo?: string | undefined;
  allowedTools: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (toolkit: string, selectedSlugs: string[]) => void | Promise<void>;
}) {
  const client = useAgentPlaneClient();
  const [tools, setTools] = useState<{ slug: string; name: string; description: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.composio.tools(toolkit) as { slug: string; name: string; description: string }[];
      setTools(data ?? []);
    } finally {
      setLoading(false);
    }
  }, [toolkit, client]);

  useEffect(() => {
    if (open) {
      fetchTools();
      setSearch("");
      const toolkitPrefix = toolkit.toUpperCase() + "_";
      const relevant = allowedTools.filter((t: string) => t.startsWith(toolkitPrefix));
      setSelected(new Set(relevant));
    }
  }, [open, toolkit, allowedTools, fetchTools]);

  const filtered = tools.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q);
  });

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.slug));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const t of filtered) next.delete(t.slug);
      } else {
        for (const t of filtered) next.add(t.slug);
      }
      return next;
    });
  }

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const selection = selected.size === tools.length ? [] : Array.from(selected);
      await onSave(toolkit, selection);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize flex items-center gap-2">
            {toolkitLogo && (
              <img src={toolkitLogo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
            )}
            {toolkit} Tools
          </DialogTitle>
          {!loading && (
            <DialogDescription>{tools.length} tools available</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input placeholder="Search tools..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-sm" />
          {loading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading tools...</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{selected.size === 0 ? "All tools (no filter)" : `${selected.size} / ${tools.length} selected`}</span>
                <button type="button" className="text-primary hover:underline" onClick={toggleAll}>
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {filtered.map((t) => (
                  <label key={t.slug} className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors">
                    <input type="checkbox" checked={selected.has(t.slug)} onChange={() => toggle(t.slug)} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.name}</div>
                      {t.description && <div className="text-xs text-muted-foreground line-clamp-1">{t.description}</div>}
                    </div>
                  </label>
                ))}
                {filtered.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No tools match your search</p>}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>{saving ? "Saving..." : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  MCP Tools Modal                                                     */
/* ------------------------------------------------------------------ */

function McpToolsModal({
  agentId,
  mcpServerId,
  serverName,
  serverLogo,
  allowedTools,
  open,
  onOpenChange,
  onSave,
}: {
  agentId: string;
  mcpServerId: string;
  serverName: string;
  serverLogo: string | null;
  allowedTools: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (selectedTools: string[]) => Promise<void>;
}) {
  const client = useAgentPlaneClient();
  const [tools, setTools] = useState<{ name: string; description?: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await client.customConnectors.listTools(agentId, mcpServerId) as { name: string; description?: string }[];
      setTools(data ?? []);
    } catch {
      setError("Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, [agentId, mcpServerId, client]);

  useEffect(() => {
    if (open) {
      fetchTools();
      setSearch("");
      setSelected(new Set(allowedTools));
    }
  }, [open, allowedTools, fetchTools]);

  const filtered = tools.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.description?.toLowerCase().includes(q) ?? false);
  });

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.name));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) { for (const t of filtered) next.delete(t.name); }
      else { for (const t of filtered) next.add(t.name); }
      return next;
    });
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const selection = selected.size === tools.length ? [] : Array.from(selected);
      await onSave(selection);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {serverLogo && <img src={serverLogo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />}
            {serverName} Tools
          </DialogTitle>
          {!loading && !error && <DialogDescription>{tools.length} tools available</DialogDescription>}
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input placeholder="Search tools..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-sm" />
          {loading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading tools...</p>
          ) : error ? (
            <p className="text-sm text-destructive py-4 text-center">{error}</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{selected.size === 0 ? "All tools (no filter)" : `${selected.size} / ${tools.length} selected`}</span>
                <button type="button" className="text-primary hover:underline" onClick={toggleAll}>{allSelected ? "Deselect All" : "Select All"}</button>
              </div>
              <div className="max-h-72 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {filtered.map((t) => (
                  <label key={t.name} className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors">
                    <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggle(t.name)} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.name}</div>
                      {t.description && <div className="text-xs text-muted-foreground line-clamp-1">{t.description}</div>}
                    </div>
                  </label>
                ))}
                {filtered.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No tools match your search</p>}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>{saving ? "Saving..." : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Connectors Manager                                                  */
/* ------------------------------------------------------------------ */

export function AgentConnectorsManager({ agentId, toolkits: initialToolkits, composioAllowedTools: initialAllowedTools, onChanged }: Props) {
  const client = useAgentPlaneClient();

  // Composio state
  const [localToolkits, setLocalToolkits] = useState<string[]>(initialToolkits);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingToolkits, setPendingToolkits] = useState<string[]>(initialToolkits);
  const [applyingToolkits, setApplyingToolkits] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ slug: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [allowedTools, setAllowedTools] = useState<string[]>(initialAllowedTools);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [toolsModalToolkit, setToolsModalToolkit] = useState<string | null>(null);

  // OAuth popup message handler refs for cleanup
  const mcpOauthHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const composioOauthHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);

  // MCP state
  const [mcpConnections, setMcpConnections] = useState<McpConnection[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [confirmMcpDisconnect, setConfirmMcpDisconnect] = useState<McpConnection | null>(null);
  const [mcpDisconnecting, setMcpDisconnecting] = useState(false);
  const [mcpToolsModal, setMcpToolsModal] = useState<McpConnection | null>(null);

  // Load Composio connectors
  const loadComposio = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.connectors.list(agentId) as ConnectorStatus[];
      setConnectors(data ?? []);
    } finally {
      setLoading(false);
    }
  }, [agentId, client]);

  // Load MCP connections
  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      const data = await client.customConnectors.list(agentId) as McpConnection[];
      setMcpConnections(data ?? []);
    } finally {
      setMcpLoading(false);
    }
  }, [agentId, client]);

  const toolkitsKey = localToolkits.join(",");
  useEffect(() => { loadComposio(); }, [loadComposio, toolkitsKey]);
  useEffect(() => { loadMcp(); }, [loadMcp]);

  // Cleanup OAuth popup handlers on unmount
  useEffect(() => {
    return () => {
      if (mcpOauthHandlerRef.current) {
        window.removeEventListener("message", mcpOauthHandlerRef.current);
        mcpOauthHandlerRef.current = null;
      }
      if (composioOauthHandlerRef.current) {
        window.removeEventListener("message", composioOauthHandlerRef.current);
        composioOauthHandlerRef.current = null;
      }
    };
  }, []);

  // Fetch total tool count per Composio toolkit
  useEffect(() => {
    if (localToolkits.length === 0) return;
    let cancelled = false;
    for (const slug of localToolkits) {
      if (toolCounts[slug] !== undefined) continue;
      client.composio.tools(slug)
        .then((data: unknown[]) => { if (!cancelled) setToolCounts((prev) => ({ ...prev, [slug]: (data ?? []).length })); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [toolkitsKey, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load available MCP servers (for Add panel)
  async function loadMcpServers() {
    try {
      const data = await client.customConnectors.listServers() as McpServer[];
      setMcpServers(data ?? []);
    } catch { /* ignore */ }
  }

  // --- Composio handlers ---

  async function handleToolsSave(toolkit: string, selectedSlugs: string[]) {
    const prefix = toolkit.toUpperCase() + "_";
    const otherTools = allowedTools.filter((t) => !t.startsWith(prefix));
    const updated = [...otherTools, ...selectedSlugs];
    await client.agents.update(agentId, { composio_allowed_tools: updated });
    setAllowedTools(updated);
    setToolsModalToolkit(null);
    onChanged?.();
  }

  async function patchToolkits(newToolkits: string[]) {
    await client.agents.update(agentId, { composio_toolkits: newToolkits });
    setLocalToolkits(newToolkits);
    onChanged?.();
  }

  async function handleApplyAdd() {
    setApplyingToolkits(true);
    try {
      await patchToolkits(pendingToolkits);
      setShowAdd(false);
    } finally {
      setApplyingToolkits(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await patchToolkits(localToolkits.filter((t) => t !== confirmDelete.slug));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSaveKey(slug: string) {
    const key = apiKeys[slug];
    if (!key) return;
    setSaving((s) => ({ ...s, [slug]: true }));
    setErrors((e) => ({ ...e, [slug]: "" }));
    try {
      await client.connectors.saveApiKey(agentId, { toolkit: slug, api_key: key });
      setApiKeys((k) => ({ ...k, [slug]: "" }));
      await loadComposio();
      onChanged?.();
    } catch (err: any) {
      setErrors((e) => ({ ...e, [slug]: err?.message ?? "Unknown error" }));
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  // --- MCP handlers ---

  async function handleMcpConnect(serverId: string) {
    setMcpConnecting(serverId);
    try {
      // Clean up previous handler if any
      if (mcpOauthHandlerRef.current) {
        window.removeEventListener("message", mcpOauthHandlerRef.current);
        mcpOauthHandlerRef.current = null;
      }
      // Open popup SYNCHRONOUSLY first
      const popup = window.open("about:blank", "mcp-oauth", "width=600,height=700");
      const data = await client.customConnectors.initiateOauth(agentId, serverId);
      if (data.redirectUrl && popup) {
        popup.location.href = data.redirectUrl;
        const handler = (event: MessageEvent) => {
          // Validate origin: only accept messages from same origin
          if (event.origin !== window.location.origin) return;
          if (event.data?.type === "agent_plane_mcp_oauth_callback") {
            popup.close();
            window.removeEventListener("message", handler);
            mcpOauthHandlerRef.current = null;
            loadMcp();
            setShowAdd(false);
            onChanged?.();
          }
        };
        mcpOauthHandlerRef.current = handler;
        window.addEventListener("message", handler);
      } else {
        popup?.close();
      }
    } finally {
      setMcpConnecting(null);
    }
  }

  async function handleMcpDisconnect() {
    if (!confirmMcpDisconnect) return;
    setMcpDisconnecting(true);
    try {
      await client.customConnectors.delete(agentId, confirmMcpDisconnect.mcp_server_id);
      setConfirmMcpDisconnect(null);
      await loadMcp();
      onChanged?.();
    } finally {
      setMcpDisconnecting(false);
    }
  }

  async function handleComposioOauth(slug: string) {
    try {
      // Clean up previous handler if any
      if (composioOauthHandlerRef.current) {
        window.removeEventListener("message", composioOauthHandlerRef.current);
        composioOauthHandlerRef.current = null;
      }
      // Open popup SYNCHRONOUSLY first
      const popup = window.open("about:blank", "composio-oauth", "width=600,height=700");
      const data = await client.connectors.initiateOauth(agentId, slug);
      if (data.redirect_url && popup) {
        popup.location.href = data.redirect_url;
        const handler = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          if (event.data?.type === "agent_plane_composio_oauth_callback" || event.data?.type === "agent_plane_oauth_callback") {
            popup.close();
            window.removeEventListener("message", handler);
            composioOauthHandlerRef.current = null;
            loadComposio();
            onChanged?.();
          }
        };
        composioOauthHandlerRef.current = handler;
        window.addEventListener("message", handler);
      } else {
        popup?.close();
      }
    } catch { /* ignore */ }
  }

  const connectedMcpServerIds = new Set(mcpConnections.map((c) => c.mcp_server_id));
  const availableMcpServers = mcpServers.filter((s) => !connectedMcpServerIds.has(s.id));

  const isAllLoading = loading || mcpLoading;
  const isEmpty = localToolkits.length === 0 && mcpConnections.length === 0;

  return (
    <>
    {/* Composio remove confirmation */}
    <ConfirmDialog
      open={!!confirmDelete}
      onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
      title="Remove Connector"
      confirmLabel="Remove"
      loadingLabel="Removing..."
      loading={deleting}
      onConfirm={handleConfirmDelete}
    >
      Remove <span className="font-medium text-foreground">{confirmDelete?.name}</span> from this agent?
    </ConfirmDialog>

    {/* MCP disconnect confirmation */}
    <ConfirmDialog
      open={!!confirmMcpDisconnect}
      onOpenChange={(open) => { if (!open) setConfirmMcpDisconnect(null); }}
      title="Disconnect Connector"
      confirmLabel="Disconnect"
      loadingLabel="Disconnecting..."
      loading={mcpDisconnecting}
      onConfirm={handleMcpDisconnect}
    >
      Disconnect <span className="font-medium text-foreground">{confirmMcpDisconnect?.server_name}</span> from this agent?
    </ConfirmDialog>

    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Connectors">
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setPendingToolkits(localToolkits); loadMcpServers(); setShowAdd(true); }}
        >
          Add
        </Button>
      </SectionHeader>
      <div>
        {showAdd && (
          <div className="mb-4 space-y-3">
            <ToolkitMultiselect value={pendingToolkits} onChange={setPendingToolkits} />

            {availableMcpServers.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {availableMcpServers.map((s) => (
                  <div key={s.id} className="flex flex-col gap-2 p-2 rounded border border-border">
                    <div className="flex items-center gap-2 min-w-0">
                      {s.logo_url && (
                        <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">{s.name}</span>
                      <Badge variant="outline" className="text-xs flex-shrink-0 ml-auto">{s.slug}</Badge>
                    </div>
                    {s.description && (
                      <p className="text-xs text-muted-foreground truncate">{s.description}</p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs mt-auto"
                      disabled={mcpConnecting === s.id}
                      onClick={() => handleMcpConnect(s.id)}
                    >
                      {mcpConnecting === s.id ? "Connecting..." : "Connect"}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleApplyAdd} disabled={applyingToolkits}>
                {applyingToolkits ? "Saving..." : "Apply"}
              </Button>
            </div>
          </div>
        )}

        {isAllLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground">No connectors added. Click Add to configure connectors.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {/* Composio connector cards */}
            {connectors.map((c) => (
              <div key={`composio-${c.slug}`} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {c.logo && (
                    <img src={c.logo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate flex-1">{c.name}</span>
                  <Badge variant={schemeBadgeVariant(c.authScheme ?? c.auth_scheme)} className="text-xs flex-shrink-0">
                    {c.authScheme ?? c.auth_scheme}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete({ slug: c.slug, name: c.name })}
                    className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-1 text-base leading-none"
                    title="Remove connector"
                  >
                    &times;
                  </button>
                </div>

                {(c.authScheme ?? c.auth_scheme) === "NO_AUTH" ? (
                  <span className="text-xs text-muted-foreground">No auth required</span>
                ) : c.connectionStatus === "ACTIVE" || c.connected ? (
                  <span className={`text-xs font-medium ${statusColor(c.connectionStatus ?? (c.connected ? "ACTIVE" : null))}`}>Connected</span>
                ) : c.connectionStatus ? (
                  <span className={`text-xs ${statusColor(c.connectionStatus)}`}>{(c.connectionStatus as string).toLowerCase()}</span>
                ) : null}

                {(() => {
                  const total = toolCounts[c.slug];
                  if (total === undefined) return null;
                  const prefix = c.slug.toUpperCase() + "_";
                  const filtered = allowedTools.filter((t) => t.startsWith(prefix));
                  const hasFilter = filtered.length > 0;
                  return (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline text-left"
                      onClick={() => setToolsModalToolkit(c.slug)}
                    >
                      {hasFilter ? `${filtered.length} / ${total} tools` : `All tools (${total})`}
                    </button>
                  );
                })()}

                {(c.authScheme ?? c.auth_scheme) === "API_KEY" && (
                  <div className="flex flex-col gap-1 mt-auto">
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        placeholder={c.connected || c.connectionStatus === "ACTIVE" ? "Update API key\u2026" : "Enter API key\u2026"}
                        value={apiKeys[c.slug] ?? ""}
                        onChange={(e) => setApiKeys((k) => ({ ...k, [c.slug]: e.target.value }))}
                        className="h-7 text-xs flex-1 min-w-0"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs flex-shrink-0"
                        disabled={!apiKeys[c.slug] || saving[c.slug]}
                        onClick={() => handleSaveKey(c.slug)}
                      >
                        {saving[c.slug] ? "Saving\u2026" : "Save"}
                      </Button>
                    </div>
                    <FormError error={errors[c.slug]} />
                  </div>
                )}

                {((c.authScheme ?? c.auth_scheme) === "OAUTH2" || (c.authScheme ?? c.auth_scheme) === "OAUTH1") && c.connectionStatus !== "ACTIVE" && !c.connected && (
                  <Button size="sm" variant="outline" className="h-7 text-xs w-full mt-auto" onClick={() => handleComposioOauth(c.slug)}>
                    Connect
                  </Button>
                )}

                {((c.authScheme ?? c.auth_scheme) === "OAUTH2" || (c.authScheme ?? c.auth_scheme) === "OAUTH1") && (c.connectionStatus === "ACTIVE" || c.connected) && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground w-full mt-auto" onClick={() => handleComposioOauth(c.slug)}>
                    Reconnect
                  </Button>
                )}
              </div>
            ))}

            {/* MCP connector cards */}
            {mcpConnections.map((c) => (
              <div key={`mcp-${c.id}`} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {c.server_logo_url && (
                    <img src={c.server_logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate flex-1">{c.server_name}</span>
                  <Badge variant="outline" className="text-xs flex-shrink-0">{c.server_slug}</Badge>
                  <button
                    type="button"
                    onClick={() => setConfirmMcpDisconnect(c)}
                    className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-1 text-base leading-none"
                    title="Disconnect"
                  >
                    &times;
                  </button>
                </div>

                {c.status === "active" ? (
                  <span className="text-xs font-medium text-green-500">Connected</span>
                ) : (
                  <span className={`text-xs ${c.status === "expired" || c.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {c.status}
                  </span>
                )}

                {c.status === "active" && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline text-left"
                    onClick={() => setMcpToolsModal(c)}
                  >
                    {c.allowed_tools.length > 0
                      ? `${c.allowed_tools.length} tools selected`
                      : "All tools (no filter)"}
                  </button>
                )}

                {(c.status === "expired" || c.status === "failed") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground mt-auto"
                    disabled={mcpConnecting === c.mcp_server_id}
                    onClick={() => handleMcpConnect(c.mcp_server_id)}
                  >
                    {mcpConnecting === c.mcp_server_id ? "Reconnecting..." : "Reconnect"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

    {/* Composio tools modal */}
    {toolsModalToolkit && (
      <ToolsModal
        toolkit={toolsModalToolkit}
        toolkitLogo={connectors.find((c) => c.slug === toolsModalToolkit)?.logo}
        allowedTools={allowedTools}
        open={!!toolsModalToolkit}
        onOpenChange={(open) => { if (!open) setToolsModalToolkit(null); }}
        onSave={handleToolsSave}
      />
    )}

    {/* MCP tools modal */}
    {mcpToolsModal && (
      <McpToolsModal
        agentId={agentId}
        mcpServerId={mcpToolsModal.mcp_server_id}
        serverName={mcpToolsModal.server_name}
        serverLogo={mcpToolsModal.server_logo_url}
        allowedTools={mcpToolsModal.allowed_tools}
        open={!!mcpToolsModal}
        onOpenChange={(open) => { if (!open) setMcpToolsModal(null); }}
        onSave={async (selectedTools) => {
          await client.customConnectors.updateAllowedTools(agentId, mcpToolsModal.mcp_server_id, selectedTools);
          setMcpToolsModal(null);
          await loadMcp();
        }}
      />
    )}
    </>
  );
}
