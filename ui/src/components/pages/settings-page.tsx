"use client";

import { useState, useRef } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { useNavigation } from "../../hooks/use-navigation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SectionHeader } from "../ui/section-header";
import { FormField } from "../ui/form-field";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Skeleton } from "../ui/skeleton";

// Use the runtime's full IANA timezone list
const TIMEZONES = typeof Intl !== "undefined" && Intl.supportedValuesOf
  ? Intl.supportedValuesOf("timeZone")
  : ["UTC"];

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  timezone: string;
  monthly_budget_usd: number;
  logo_url: string | null;
}

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface SettingsData {
  tenant: Tenant;
  api_keys: ApiKey[];
}

export interface SettingsPageProps {
  initialData?: SettingsData;
  /** If true, hides the danger zone (delete company) */
  hideDangerZone?: boolean;
}

export function SettingsPage({ initialData, hideDangerZone }: SettingsPageProps) {
  const { mutate } = useSWRConfig();

  const { data: tenantData, error: tenantError, isLoading: tenantLoading } = useApi<Tenant>(
    "settings-tenant",
    (c) => c.tenants.getMe() as Promise<Tenant>,
    initialData ? { fallbackData: initialData.tenant } : undefined,
  );

  const { data: apiKeysData, error: apiKeysError, isLoading: apiKeysLoading } = useApi<ApiKey[]>(
    "settings-keys",
    (c) => (c.keys.list ? c.keys.list() : Promise.resolve([])) as Promise<ApiKey[]>,
    initialData ? { fallbackData: initialData.api_keys } : undefined,
  );

  const data = tenantData && apiKeysData ? { tenant: tenantData, api_keys: apiKeysData } : undefined;
  const error = tenantError || apiKeysError;
  const isLoading = tenantLoading || apiKeysLoading;

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load settings: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CompanyForm tenant={data.tenant} onSaved={() => { mutate("settings-tenant"); mutate("settings-keys"); }} />
      <ApiKeysSection initialKeys={data.api_keys} onChanged={() => { mutate("settings-tenant"); mutate("settings-keys"); }} />
      {!hideDangerZone && (
        <DangerZone tenantId={data.tenant.id} tenantName={data.tenant.name} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Company Form                                                       */
/* ------------------------------------------------------------------ */

function CompanyForm({ tenant, onSaved }: { tenant: Tenant; onSaved: () => void }) {
  const client = useAgentPlaneClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(tenant.name);
  const [budget, setBudget] = useState(tenant.monthly_budget_usd.toString());
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url ?? "");
  const [saving, setSaving] = useState(false);

  const isDirty =
    name !== tenant.name ||
    budget !== tenant.monthly_budget_usd.toString() ||
    timezone !== tenant.timezone ||
    (logoUrl || "") !== (tenant.logo_url ?? "");

  async function handleSave() {
    setSaving(true);
    try {
      await client.tenants.updateMe({
        name,
        monthly_budget_usd: parseFloat(budget),
        timezone,
        logo_url: logoUrl || null,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Logo */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Logo" />
        <div className="flex items-center gap-5">
          {logoUrl ? (
            <img src={logoUrl} alt={name} className="w-16 h-16 rounded-xl object-cover border border-border" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground">
              {name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?"}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Upload a logo for your company. Recommended size: 256x256px.</p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                Upload image
              </Button>
              {logoUrl && (
                <Button size="sm" variant="outline" onClick={() => setLogoUrl("")}>
                  Remove
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setLogoUrl(reader.result as string);
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Company Details */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Company Details" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <FormField label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Slug">
            <Input value={tenant.slug} readOnly disabled className="opacity-60" />
          </FormField>
          <FormField label="Status">
            <div className="flex items-center h-9">
              <Badge variant={tenant.status === "active" ? "default" : "destructive"}>
                {tenant.status}
              </Badge>
            </div>
          </FormField>
          <FormField label="Timezone">
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Monthly Budget (USD)">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="pl-7"
              />
            </div>
          </FormField>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  API Keys Section                                                   */
/* ------------------------------------------------------------------ */

function ApiKeysSection({ initialKeys, onChanged }: { initialKeys: ApiKey[]; onChanged: () => void }) {
  const client = useAgentPlaneClient();
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("default");
  const [showCreate, setShowCreate] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");

  async function handleCreate() {
    setCreating(true);
    try {
      const result = await client.keys.create!({ name: newKeyName }) as { key: string };
      setRawKey(result.key);
      setShowCreate(false);
      setNewKeyName("default");
      onChanged();
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError("");
    try {
      await client.keys.revoke!(revokeTarget.id);
      setRevokeTarget(null);
      onChanged();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRevoking(false);
    }
  }

  const activeKeys = initialKeys.filter((k) => !k.revoked_at);
  const revokedKeys = initialKeys.filter((k) => k.revoked_at);

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="API Keys">
        <Button variant="outline" size="sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "+ New Key"}
        </Button>
      </SectionHeader>

      {rawKey && (
        <div className="mb-4 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
          <p className="text-sm font-medium mb-1">New API key created — copy it now, it won&apos;t be shown again:</p>
          <code className="block text-xs font-mono bg-black/20 p-2 rounded break-all select-all">{rawKey}</code>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setRawKey(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {showCreate && (
        <div className="mb-4 flex gap-2 items-end">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Key Name</label>
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="default"
              className="w-64"
            />
          </div>
          <Button size="sm" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Prefix</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Last Used</th>
              <th className="text-left p-3 font-medium">Created</th>
              <th className="text-right p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {activeKeys.map((k) => (
              <tr key={k.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-medium">{k.name}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{k.key_prefix}...</td>
                <td className="p-3"><Badge variant="default">active</Badge></td>
                <td className="p-3 text-muted-foreground text-xs">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="p-3 text-right">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setRevokeTarget(k)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {revokedKeys.map((k) => (
              <tr key={k.id} className="border-b border-border opacity-50">
                <td className="p-3">{k.name}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{k.key_prefix}...</td>
                <td className="p-3"><Badge variant="destructive">revoked</Badge></td>
                <td className="p-3 text-muted-foreground text-xs">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="p-3"></td>
              </tr>
            ))}
            {initialKeys.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No API keys</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title="Revoke API Key"
        confirmLabel="Revoke"
        loadingLabel="Revoking..."
        loading={revoking}
        error={revokeError}
        onConfirm={handleRevoke}
      >
        Revoke API key <span className="font-medium text-foreground">{revokeTarget?.name}</span> ({revokeTarget?.key_prefix}...)? This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Danger Zone                                                        */
/* ------------------------------------------------------------------ */

function DangerZone({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const client = useAgentPlaneClient();
  const { onNavigate, basePath } = useNavigation();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await client.tenants.deleteMe!();
      setOpen(false);
      onNavigate(basePath || "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-lg border border-destructive/30 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Permanently delete this company and all its agents, runs, sessions, and API keys.
          </p>
        </div>
        <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
          Delete Company
        </Button>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={(v) => { if (!v) { setOpen(false); setError(""); } }}
        title="Delete Company"
        confirmLabel="Delete Company"
        loadingLabel="Deleting..."
        loading={deleting}
        error={error}
        onConfirm={handleDelete}
      >
        This action <span className="font-medium text-foreground">cannot be undone</span>. All agents, runs, sessions, and API keys for <span className="font-medium text-foreground">{tenantName}</span> will be permanently deleted.
      </ConfirmDialog>
    </div>
  );
}
