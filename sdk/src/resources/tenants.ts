import type { AgentPlane } from "../client";
import type { Tenant, UpdateTenantParams } from "../types";

export class TenantsResource {
  constructor(private readonly _client: AgentPlane) {}

  /** Get the current tenant. */
  async getMe(): Promise<Tenant> {
    return this._client._request<Tenant>("GET", "/api/tenants/me");
  }

  /** Update the current tenant (name, timezone, budget, logo). */
  async updateMe(params: UpdateTenantParams): Promise<Tenant> {
    return this._client._request<Tenant>("PATCH", "/api/tenants/me", {
      body: params,
    });
  }
}
