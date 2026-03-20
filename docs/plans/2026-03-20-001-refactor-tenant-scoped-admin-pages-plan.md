---
title: "refactor: Scope all admin pages to active tenant"
type: refactor
status: active
date: 2026-03-20
---

# refactor: Scope all admin pages to active tenant

## Overview

All admin pages currently show cross-tenant data (all agents, all runs, etc.). Now that we have a tenant switcher in the sidebar, every page should filter by the active tenant cookie. Tenant columns and the Tenants metric card become redundant and should be removed.

## Proposed Solution

Read `ap-active-tenant` cookie server-side via `getActiveTenantId()` (already exists at `src/lib/active-tenant.ts`). Add `WHERE tenant_id = $N` to every admin page query. Remove tenant columns from tables and the Tenants metric card from the dashboard.

## Changes

### 1. Dashboard — `src/app/admin/(dashboard)/page.tsx`

- Read active tenant: `const tenantId = getActiveTenantId();`
- If no tenant selected, show "Select a tenant" message
- Add `WHERE tenant_id = $1` to all metric queries (agents, runs, active runs, spend)
- **Remove** the "Tenants" metric card and its query (`tenant_count`)
- Grid changes from 5 columns to 4 (Agents, Runs, Active Runs, Spend)
- Run charts: filter by tenant

### 2. Agents — `src/app/admin/(dashboard)/agents/page.tsx`

- Read active tenant, filter: `WHERE a.tenant_id = $1`
- **Remove** the tenant JOIN (`LEFT JOIN tenants t ON t.id = a.tenant_id`)
- **Remove** `tenant_name` from the query select and Zod schema
- **Remove** "Tenant" table column header and cell
- **Remove** the `SELECT * FROM tenants` query (line 52) — no longer needed for dropdown
- Update `AddAgentForm` call: pass the active tenant ID instead of a tenants list

### 3. Agent Detail — `src/app/admin/(dashboard)/agents/[agentId]/page.tsx`

- Add tenant guard: verify agent belongs to active tenant (or show not-found)
- Remove tenant name display from subtitle

### 4. Runs — `src/app/admin/(dashboard)/runs/page.tsx`

- Read active tenant, filter: `WHERE r.tenant_id = $1`
- **Remove** the tenant JOIN (`JOIN tenants t ON t.id = r.tenant_id`)
- **Remove** `tenant_name` from schema
- **Remove** "Tenant" table column header and cell

### 5. Run Detail — `src/app/admin/(dashboard)/runs/[runId]/page.tsx`

- Add tenant guard: verify run belongs to active tenant

### 6. MCP Servers — `src/app/admin/(dashboard)/mcp-servers/page.tsx`

- MCP servers are global (no tenant_id) — no query change needed
- No tenant column to remove

### 7. Plugin Marketplaces — `src/app/admin/(dashboard)/plugin-marketplaces/page.tsx`

- Plugin marketplaces are global — no query change needed
- No tenant column to remove

### 8. AddAgentForm — `src/app/admin/(dashboard)/agents/add-agent-form.tsx`

- Remove `tenants` prop and the tenant selector dropdown
- Use the active tenant ID from cookie instead (read via `getActiveTenantId()` and pass as prop, or read client-side from cookie)
- POST to `/api/admin/agents` with the active tenant ID

## Acceptance Criteria

- [ ] Dashboard shows only active tenant's metrics (4 cards, no Tenants card)
- [ ] Agents page shows only active tenant's agents, no Tenant column
- [ ] Runs page shows only active tenant's runs, no Tenant column
- [ ] Agent/Run detail pages verify ownership to active tenant
- [ ] AddAgentForm uses active tenant automatically (no tenant selector)
- [ ] "Select a tenant" shown when no tenant cookie is set
- [ ] All queries use `WHERE tenant_id = $1` with active tenant
- [ ] No cross-tenant data leaks in admin UI
- [ ] Existing tests still pass
