"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "../ui/dialog";
import { SectionHeader } from "../ui/section-header";

interface AgentPlugin {
  marketplace_id: string;
  plugin_name: string;
}

interface Marketplace {
  id: string;
  name: string;
  github_repo: string;
}

interface AvailablePlugin {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  hasSkills: boolean;
  hasAgents: boolean;
  hasMcpJson: boolean;
}

interface Props {
  agentId: string;
  initialPlugins: AgentPlugin[];
  onSaved?: () => void;
}

export function AgentPluginManager({ agentId, initialPlugins, onSaved }: Props) {
  const client = useAgentPlaneClient();
  const [plugins, setPlugins] = useState<AgentPlugin[]>(initialPlugins);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [availablePlugins, setAvailablePlugins] = useState<AvailablePlugin[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [marketplaceNames, setMarketplaceNames] = useState<Record<string, string>>({});
  const savedSnapshot = useRef(JSON.stringify(initialPlugins));

  useEffect(() => {
    savedSnapshot.current = JSON.stringify(initialPlugins);
    setPlugins(initialPlugins);
  }, [initialPlugins]);

  const isDirty = useMemo(
    () => JSON.stringify(plugins) !== savedSnapshot.current,
    [plugins],
  );

  // Fetch marketplaces on mount
  useEffect(() => {
    (client.pluginMarketplaces.list() as Promise<Marketplace[]>)
      .then((data: Marketplace[]) => {
        setMarketplaces(data);
        const names: Record<string, string> = {};
        for (const m of data) names[m.id] = m.name;
        setMarketplaceNames(names);
      })
      .catch(() => {});
  }, [client]);

  const loadPluginsForMarketplace = useCallback(async (marketplaceId: string) => {
    setSelectedMarketplace(marketplaceId);
    setLoadingPlugins(true);
    setAvailablePlugins([]);
    try {
      const data = await client.pluginMarketplaces.listPlugins(marketplaceId) as AvailablePlugin[];
      setAvailablePlugins(data ?? []);
    } catch { /* ignore */ } finally {
      setLoadingPlugins(false);
    }
  }, [client]);

  function isPluginEnabled(marketplaceId: string, pluginName: string): boolean {
    return plugins.some(
      (p) => p.marketplace_id === marketplaceId && p.plugin_name === pluginName,
    );
  }

  function togglePlugin(marketplaceId: string, pluginName: string) {
    if (isPluginEnabled(marketplaceId, pluginName)) {
      setPlugins((prev) =>
        prev.filter(
          (p) => !(p.marketplace_id === marketplaceId && p.plugin_name === pluginName),
        ),
      );
    } else {
      setPlugins((prev) => [
        ...prev,
        { marketplace_id: marketplaceId, plugin_name: pluginName },
      ]);
    }
  }

  function removePlugin(index: number) {
    setPlugins((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await client.agents.update(agentId, { plugins });
      savedSnapshot.current = JSON.stringify(plugins);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Plugins">
        <div className="flex items-center gap-3">
          {isDirty && <Badge variant="destructive" className="text-xs">Unsaved changes</Badge>}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              Add Plugins
            </Button>
            <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
              {saving ? "Saving..." : "Save Plugins"}
            </Button>
          </div>
        </div>
      </SectionHeader>
      <div>
        {plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No plugins enabled. Click &quot;Add Plugins&quot; to browse available plugins.
          </p>
        ) : (
          <div className="space-y-2">
            {plugins.map((p, i) => (
              <div
                key={`${p.marketplace_id}:${p.plugin_name}`}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <div>
                  <span className="text-sm font-medium">{p.plugin_name}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    from {marketplaceNames[p.marketplace_id] ?? p.marketplace_id.slice(0, 8)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => removePlugin(i)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add plugins dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Add Plugins</DialogTitle>
            </DialogHeader>

            <DialogBody className="flex-1 overflow-hidden flex flex-col gap-3">
              {marketplaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No plugin marketplaces registered. Add one from the Plugin Marketplaces page first.
                </p>
              ) : (
                <>
                  <div className="flex gap-2 flex-wrap">
                    {marketplaces.map((m) => (
                      <Button
                        key={m.id}
                        size="sm"
                        variant={selectedMarketplace === m.id ? "default" : "outline"}
                        onClick={() => loadPluginsForMarketplace(m.id)}
                      >
                        {m.name}
                      </Button>
                    ))}
                  </div>

                  {selectedMarketplace && (
                    <div className="overflow-y-auto border border-border rounded-lg divide-y divide-border">
                      {loadingPlugins ? (
                        <p className="p-4 text-sm text-muted-foreground text-center">Loading plugins...</p>
                      ) : availablePlugins.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground text-center">No plugins found in this marketplace.</p>
                      ) : (
                        availablePlugins.map((ap) => {
                          const enabled = isPluginEnabled(selectedMarketplace, ap.name);
                          return (
                            <div
                              key={ap.name}
                              className="flex items-center justify-between px-3 py-2.5 hover:bg-muted/30 cursor-pointer transition-colors"
                              onClick={() => togglePlugin(selectedMarketplace, ap.name)}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{ap.displayName}</span>
                                  {ap.version && (
                                    <span className="text-xs text-muted-foreground">v{ap.version}</span>
                                  )}
                                </div>
                                {ap.description && (
                                  <p className="text-xs text-muted-foreground truncate">{ap.description}</p>
                                )}
                                <div className="flex gap-1 mt-1">
                                  {ap.hasAgents && <Badge variant="secondary" className="text-[10px] px-1 py-0">Agents</Badge>}
                                  {ap.hasSkills && <Badge variant="secondary" className="text-[10px] px-1 py-0">Skills</Badge>}
                                  {ap.hasMcpJson && <Badge variant="secondary" className="text-[10px] px-1 py-0">MCP</Badge>}
                                </div>
                              </div>
                              <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                enabled
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground"
                              }`}>
                                {enabled && <span className="text-xs">&#10003;</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </>
              )}
            </DialogBody>

            <DialogFooter>
              <Button size="sm" onClick={() => setDialogOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
