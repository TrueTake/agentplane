import { cookies } from "next/headers";
import { query, queryOne } from "@/db";
import { TenantRow, ApiKeyRow } from "@/lib/validation";
import { CompanyForm } from "./company-form";
import { ApiKeysSection } from "./api-keys-section";
import { DeleteCompanyButton } from "./delete-company-button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const tenantId = cookieStore.get("ap-active-tenant")?.value;

  if (!tenantId) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Select a company from the sidebar to view settings.</p>
      </div>
    );
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);

  if (!tenant) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Company not found. Select a different company from the sidebar.</p>
      </div>
    );
  }

  const apiKeys = await query(
    ApiKeyRow.omit({ key_hash: true }),
    `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );

  return (
    <div className="space-y-6">
      {/* Tenant Details */}
      <CompanyForm tenant={{
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        timezone: tenant.timezone,
        monthly_budget_usd: tenant.monthly_budget_usd,
        logo_url: tenant.logo_url,
      }} />

      {/* API Keys */}
      <ApiKeysSection tenantId={tenantId} initialKeys={apiKeys} />

      {/* Danger Zone */}
      <div className="rounded-lg border border-destructive/30 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Permanently delete this company and all its agents, runs, sessions, and API keys.
            </p>
          </div>
          <DeleteCompanyButton tenantId={tenant.id} tenantName={tenant.name} />
        </div>
      </div>
    </div>
  );
}
