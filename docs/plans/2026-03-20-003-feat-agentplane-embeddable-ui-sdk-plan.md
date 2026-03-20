---
title: "feat: AgentPlane Embeddable React Component Library"
type: feat
status: active
date: 2026-03-20
origin: docs/brainstorms/2026-03-20-agentco-agentplane-integration-requirements.md
---

# feat: AgentPlane Embeddable React Component Library

## Enhancement Summary

**Deepened on:** 2026-03-20
**Sections enhanced:** All
**Research agents used:** best-practices-researcher, oauth-researcher, architecture-strategist, security-sentinel, performance-oracle, code-simplicity-reviewer

### Key Improvements
1. **Security: Browser token architecture** — Raw API keys must not be exposed in browser bundles. Added scoped browser token minting (Critical).
2. **Architecture: Split router.refresh() concern** — 25+ call sites use `router.refresh()` for cache invalidation, not navigation. Replaced RouterAdapter with simpler navigation props + SWR-based data invalidation.
3. **Performance: Mandatory separate entry points** — Single bundle is ~235KB min+gzip; with entry splitting most consumers load ~50KB. Recharts and CodeMirror must be separate entry points.
4. **OAuth: Origin validation and COOP headers** — Current postMessage implementation has no origin validation (HIGH security finding). Added concrete remediation.
5. **Simplification: Reduced abstraction surface** — Removed formal RouterAdapter interface, custom useQuery hook, and theme.css file. Use SWR, simple props, and documented CSS variables instead.

### New Considerations Discovered
- `router.refresh()` is the dominant pattern (25+ sites) and has no equivalent outside Next.js — requires SWR cache invalidation strategy
- `Cross-Origin-Opener-Policy: unsafe-none` required on OAuth callback routes for popup pattern to work
- Split Provider context into 3 (client, tenant, router) to prevent full-tree re-renders on tenant switch

---

## Overview

Extract AgentPlane's admin UI into a published React component library (`@getcatalystiq/agent-plane-ui`) that AgentCo can embed in its layout. Page-level components fill the content area next to AgentCo's sidebar, powered by the existing `@getcatalystiq/agent-plane` SDK for data fetching. AgentPlane stays as a separate app; A2A remains the universal interface (see origin: docs/brainstorms/2026-03-20-agentco-agentplane-integration-requirements.md).

## Problem Statement

AgentCo and AgentPlane are separate codebases connected via A2A. Users experience two systems — fragmented UIs, duplicate config, inconsistent state. AgentCo needs to embed AgentPlane's agent management screens (agents, runs, connectors, plugins, MCP servers, settings) directly in its UI so users see one product.

## Proposed Solution

A monorepo `ui/` package (sibling to `sdk/`) that publishes page-level React client components. Components accept an SDK client instance for API calls and CSS variables for theming. AgentCo provisions tenants via the SDK, stores credentials, and passes them to the component library via a Provider.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────┐
│ AgentCo App                                     │
│ ┌───────────┐ ┌───────────────────────────────┐ │
│ │  Sidebar   │ │  @getcatalystiq/agent-plane-ui│ │
│ │            │ │  <AgentListPage />             │ │
│ │ AgentPlane │ │  <AgentDetailPage />           │ │
│ │  > Agents  │ │  <RunListPage />               │ │
│ │  > Runs    │ │  ...                           │ │
│ │  > MCP     │ │                                │ │
│ │  > Plugins │ │  Uses SDK client for API calls │ │
│ │  > Settings│ │  Accepts CSS vars for theming  │ │
│ └───────────┘ └───────────────────────────────┘ │
│                        │                         │
│              @getcatalystiq/agent-plane SDK       │
│                        │                         │
└────────────────────────┼─────────────────────────┘
                         │ HTTPS
                   ┌─────┴─────┐
                   │ AgentPlane │
                   │  REST API  │
                   │  A2A API   │
                   └───────────┘
```

### Research Insights: Architecture

**Split concerns (architecture review):**
- Navigation (`onNavigate`, `LinkComponent` props) is one concern
- Data invalidation after mutations is a separate concern — use SWR `mutate()` for cache invalidation instead of trying to abstract `router.refresh()`
- The current codebase has 25+ `router.refresh()` call sites that need to become SWR cache invalidations

**Provider context splitting (performance review):**
Split into three React contexts to prevent unnecessary re-renders:
```typescript
// Static — never changes after mount
const ClientContext = React.createContext<AgentPlane | null>(null);
// Dynamic — changes on tenant switch
const TenantContext = React.createContext<TenantState | null>(null);
// Navigation — changes on route change
const NavigationContext = React.createContext<NavigationProps | null>(null);
```

**Initial-data contract (architecture review):**
Components should support dual-mode data loading:
- Accept optional `initialData` prop (for RSC hosts that server-fetch)
- Fall back to SDK fetch via SWR if `initialData` is absent (for pure client-side hosts)
This preserves fast page loads in the AgentPlane standalone admin while working in any React host.

### Critical Prerequisite: Tenant-Scoped API Endpoints

**This is the highest-leverage first decision** (identified by SpecFlow analysis).

Currently, admin pages query `/api/admin/*` routes authenticated with `ADMIN_API_KEY`. The SDK only covers tenant-scoped `/api/*` routes. Exposing `ADMIN_API_KEY` to browser-side components is not viable.

**Decision: Tenant-scoped endpoints for everything the UI needs.**

New tenant-scoped API endpoints required:

| Endpoint | Purpose | Currently |
|---|---|---|
| `GET /api/models` | Model catalog for selector | Admin-only (`/api/admin/models`) |
| `GET /api/agents/:id/stats` | Agent metric cards | Direct DB query in RSC |
| `GET /api/dashboard/stats` | Dashboard overview stats | Direct DB query in RSC |
| `GET /api/dashboard/charts` | Run/cost chart data | Direct DB query in RSC |
| `PATCH /api/tenants/me` | Update own tenant settings | Admin-only (`/api/admin/tenants`) |
| `GET /api/composio/toolkits` | Composio toolkit discovery | Admin-only |
| `GET /api/composio/tools` | Composio tool listing | Admin-only |

Some already exist: agent CRUD (`/api/agents`), runs (`/api/runs`), sessions (`/api/sessions`), MCP servers (`/api/mcp-servers`), plugin marketplaces (`/api/plugin-marketplaces`). Verify completeness against all page needs.

**SDK additions:** Add corresponding methods to `@getcatalystiq/agent-plane` SDK for each new endpoint.

### Security: Browser Token Architecture

> **CRITICAL (security review):** Raw `ap_live_*` API keys must never be exposed in browser bundles. Any page visitor can extract them from source or DevTools.

**Solution: Scoped browser tokens.**

1. AgentCo's backend calls AgentPlane's API (server-to-server) to mint a short-lived, scoped browser token
2. AgentCo passes the browser token to the component library via the Provider
3. Browser token has restricted permissions (read-only by default, write for specific resources)
4. Token expires after 30 minutes; Provider handles refresh via `onTokenRefresh` callback

**New endpoint:**
```
POST /api/keys/browser-token
Authorization: Bearer ap_live_...
Body: { scopes: ["agents:read", "agents:write", "runs:read", ...], ttl: 1800 }
Response: { token: "ap_browser_...", expires_at: "..." }
```

**Alternative (simpler for v1):** If AgentCo's backend proxies all API calls to AgentPlane, the API key never reaches the browser. The SDK client would point to AgentCo's proxy URL instead of AgentPlane directly. This trades security complexity for a proxy layer in AgentCo.

### Implementation Phases

#### Phase 1: API Surface + SDK Completion

Ensure all data the UI pages need is available via tenant-scoped REST endpoints, and the SDK covers them.

**Tasks:**

- [ ] Audit all 14 admin page components; list every `/api/admin/*` call and direct DB query
- [ ] Create tenant-scoped endpoints for missing operations (models, stats, charts, tenant self-update, composio discovery)
- [ ] Implement browser token endpoint (`POST /api/keys/browser-token`) with scoped permissions
- [ ] Add SDK methods for new endpoints (`client.models.list()`, `client.dashboard.stats()`, `client.dashboard.charts()`, `client.tenants.updateMe()`, `client.composio.toolkits()`, `client.composio.tools()`)
- [ ] Add SDK methods for any existing endpoints not yet covered (verify MCP servers, plugin marketplaces have full CRUD in SDK)
- [ ] Tests for all new endpoints and SDK methods

**Files:**

- `src/app/api/models/route.ts` — tenant-scoped model catalog
- `src/app/api/dashboard/stats/route.ts` — dashboard stats
- `src/app/api/dashboard/charts/route.ts` — chart data
- `src/app/api/tenants/me/route.ts` — tenant self-update (PATCH)
- `src/app/api/keys/browser-token/route.ts` — scoped browser token minting
- `src/app/api/composio/toolkits/route.ts` — tenant-scoped (may already exist)
- `src/app/api/composio/tools/route.ts` — tenant-scoped (may already exist)
- `sdk/src/resources/*.ts` — new SDK resource methods

#### Phase 2: UI Primitive Extraction

Extract shared UI components first — they have minimal Next.js coupling (only `Link` in 2 files, `useRouter` in 1 component) and provide immediate value.

**Tasks:**

- [ ] Create `ui/` directory structure (see scaffolding below)
- [ ] Copy UI primitives to `ui/src/components/ui/`: button, card, badge, input, select, textarea, form-field, section-header, detail-page-header, skeleton, metric-card, admin-table, pagination-bar, form-error, tabs, dialog, confirm-dialog, copy-button
- [ ] Replace all `@/lib/utils` imports with local `../utils`
- [ ] Replace `next/link` usage with a `LinkComponent` prop from navigation context
- [ ] Verify each component works as a pure client component (no server-only imports)
- [ ] Extract complex shared components: `ModelSelector`, `FileTreeEditor`, `ToolkitMultiselect`, `LocalDate`, `ThemeToggle`
- [ ] `ModelSelector`: replace hard-coded `fetch("/api/admin/models")` with SDK client call
- [ ] Export all primitives from `ui/src/index.ts`

#### Phase 3: Package Scaffolding + Provider

Set up the `ui/` package and provider infrastructure.

**Tasks:**

- [ ] Create `ui/` directory structure:
  ```
  ui/
    package.json          # @getcatalystiq/agent-plane-ui
    tsup.config.ts        # ESM + CJS + DTS, separate entry points
    tsconfig.json
    src/
      index.ts            # core exports (primitives, provider, types)
      charts.ts           # entry point for Recharts components
      editor.ts           # entry point for CodeMirror components
      provider.tsx        # AgentPlaneProvider (split contexts)
      types.ts            # NavigationProps, component prop types
      utils.ts            # cn() utility (clsx + tailwind-merge)
      components/
        ui/               # extracted UI primitives
        pages/            # page-level components
  ```
- [ ] Configure `tsup` with multiple entry points:
  ```typescript
  // tsup.config.ts
  export default defineConfig({
    entry: {
      index: 'src/index.ts',
      charts: 'src/charts.ts',    // Recharts (~50KB)
      editor: 'src/editor.ts',    // CodeMirror (~120KB)
    },
    format: ['cjs', 'esm'],
    dts: true,
    treeshake: true,
    splitting: true,
    external: ['react', 'react-dom', '@getcatalystiq/agent-plane'],
  });
  ```
- [ ] Set up `package.json`:
  - `peerDependencies`: `react`, `react-dom`, `@getcatalystiq/agent-plane` (SDK), `swr`
  - `dependencies`: `clsx`, `class-variance-authority`, `tailwind-merge`, `@radix-ui/*`, `cmdk`
  - `exports` field mapping entry points to ESM/CJS/DTS files
  - `sideEffects: false` for tree-shaking
  - React version range: `"^18.0.0 || ^19.0.0"`
- [ ] Implement `AgentPlaneProvider` with split contexts:
  ```typescript
  interface AgentPlaneProviderProps {
    client: AgentPlane;
    onNavigate: (path: string) => void;
    LinkComponent?: React.ComponentType<{ href: string; children: React.ReactNode }>;
    onAuthError?: (error: AgentPlaneError) => void;
    basePath?: string;  // default: '/'
    children: React.ReactNode;
  }
  ```
- [ ] Add build script to root `package.json`: `npm run ui:build`
- [ ] Validate package with `publint` + `@arethetypeswrong/cli`

**Research Insights: Packaging (best-practices research):**
- Build CSS separately with PostCSS, not tsup — tsup CSS handling is limited
- Use `@layer` for CSS specificity control: `@layer agent-plane { ... }` prevents host app style conflicts
- Ship optional framework adapters as separate entry points (`./adapters/next`, `./adapters/react-router`) for convenience
- Enable npm provenance for supply chain security
- Use Changesets for versioning in the monorepo

#### Phase 4: Page Component Extraction

Convert RSC pages to client components that fetch via SWR + SDK.

**Components to extract (R3a–R3g from origin doc):**

| Component | Source | Key Challenges |
|---|---|---|
| `<AgentListPage />` | `agents/page.tsx` | DB query → SDK, link routing |
| `<AgentDetailPage />` | `agents/[agentId]/page.tsx` | Tabbed layout, sub-components (edit-form, connector-manager, skill/plugin managers, schedule, runs) |
| `<RunListPage />` | `runs/page.tsx` | Filters, pagination, source badges |
| `<RunDetailPage />` | `runs/[runId]/page.tsx` | Transcript viewer, cancel button |
| `<McpServerListPage />` | `mcp-servers/page.tsx` | CRUD, OAuth initiation |
| `<McpServerDetailPage />` | `mcp-servers/[serverId]/page.tsx` | Edit form, connection status |
| `<PluginMarketplaceListPage />` | `plugin-marketplaces/page.tsx` | Marketplace listing |
| `<PluginMarketplaceDetailPage />` | `plugin-marketplaces/[marketplaceId]/page.tsx` | Plugin editor (CodeMirror), tabbed (Agents, Skills, Connectors) |
| `<SettingsPage />` | `settings/page.tsx` | Tenant self-update, API keys, logo upload, danger zone |
| `<DashboardPage />` | `page.tsx` | Stat cards, Recharts charts |

**Per-component conversion pattern:**

1. Remove server component data fetching (direct DB queries)
2. Add `"use client"` directive
3. Use SWR with SDK client for data loading:
   ```typescript
   const { data: agents, mutate } = useSWR('agents', () => client.agents.list());
   ```
4. Replace `router.refresh()` with SWR `mutate()` after mutations:
   ```typescript
   // Before (Next.js): router.refresh()
   // After (library): mutate('agents')
   ```
5. Replace `next/link` with `LinkComponent` from navigation context
6. Replace hard-coded `/admin/*` paths with `basePath`-relative paths
7. Add loading skeletons for async data
8. Accept `agentId`, `runId`, etc. as props (not from URL params)
9. Accept optional `initialData` prop for SSR-compatible hosts

**Tasks:**

- [ ] Convert and extract each page component (10 pages), starting with simplest (RunListPage) and ending with most complex (AgentDetailPage)
- [ ] Convert sub-components: `edit-form.tsx`, `connector-manager.tsx`, `skill-manager.tsx`, `plugin-manager.tsx`, `schedule-form.tsx`, `agent-runs.tsx`, `transcript-viewer.tsx`, `run-charts.tsx`
- [ ] Replace all 25+ `router.refresh()` calls with SWR `mutate()` cache invalidation
- [ ] Handle OAuth flows: popup window pattern with security hardening (see OAuth section)
- [ ] Add loading/error states for all data-fetching components
- [ ] Export page components from separate entry point or `ui/src/index.ts`

**Research Insights: Data Fetching (performance review):**
- Configure SWR with `staleTime: 5min` for stable data, `revalidateOnFocus: false`
- The RSC→SDK transition adds 70-240ms per page load — SWR's stale-while-revalidate makes repeat navigations instant
- Virtualize transcript rendering for large transcripts (>100 events)
- Lazy-mount/destroy CodeMirror instances per tab to control memory (~5-8MB per instance)

#### Phase 5: Integration Testing & Documentation

**Tasks:**

- [ ] Create a minimal Vite test app that renders each page component with a mock SDK client
- [ ] Test theming: verify CSS variable overrides work correctly in light and dark modes
- [ ] Test navigation: verify `onNavigate` and `LinkComponent` work correctly
- [ ] Test OAuth flows: verify popup-based OAuth with origin validation
- [ ] Test browser token refresh flow
- [ ] Test separate entry points: verify charts and editor are not loaded unless explicitly imported
- [ ] Write README for `ui/` package with:
  - Installation and setup
  - Provider configuration (including browser token pattern)
  - Navigation setup examples (React Router, Next.js)
  - Theming guide (CSS variable names and defaults)
  - Available components and props
  - Required CSP directives
- [ ] Publish to npm as `@getcatalystiq/agent-plane-ui`
- [ ] Test in CI matrix: React 18 + React 19

### OAuth Callback Strategy

When embedded in AgentCo, OAuth redirects (Composio + MCP servers) can't redirect back to AgentCo's domain because the OAuth apps are registered with AgentPlane's callback URLs.

**Solution: Popup window pattern with security hardening.**

1. When user clicks "Connect," open popup **synchronously** in the click handler (preserves user gesture chain, avoids popup blockers):
   ```typescript
   // CORRECT: open synchronously, navigate after async
   const popup = window.open('about:blank', 'oauth', 'width=600,height=700');
   const { url } = await client.connectors.initiateOAuth(agentId, toolkitId);
   popup.location.href = url;
   ```
2. OAuth flow happens entirely in the popup (redirects back to AgentPlane's domain)
3. After auth completes, callback page posts message with **explicit target origin** (never `"*"`):
   ```typescript
   // Callback page — origin from signed OAuth state
   window.opener.postMessage(
     { type: 'agent_plane_oauth_complete', connectionId },
     hostOrigin  // from HMAC-signed state parameter
   );
   window.close();
   ```
4. Parent window validates `event.origin` strictly:
   ```typescript
   window.addEventListener('message', (event) => {
     if (event.origin !== agentPlaneOrigin) return;
     if (event.data.type !== 'agent_plane_oauth_complete') return;
     mutate(`connections-${agentId}`); // SWR refetch
   });
   ```
5. **COOP header required:** OAuth callback routes must set `Cross-Origin-Opener-Policy: unsafe-none` so `window.opener` is accessible. Without this, the popup cannot communicate back.
6. **Fallback:** If popup is blocked, detect via `popup === null` and fall back to new tab with return URL parameter.

### Keeping Admin UI and Library in Sync

The standalone AgentPlane admin UI and the component library must share source code to avoid duplication (origin: success criteria).

**Strategy: Library is the source of truth.**

1. `ui/src/components/` contains the canonical component code
2. AgentPlane's `src/app/admin/` pages become thin wrappers:
   - RSC page fetches data via DB query (fast, no extra HTTP hop)
   - Passes data as `initialData` prop to the library's client component
   - Library component uses `initialData` if present, fetches via SWR if absent
3. AgentPlane's admin pages import from `@getcatalystiq/agent-plane-ui` via workspace reference

**Research Insights (architecture review):**
- The thin-wrapper approach is architecturally sound because the current RSC pages are already structurally two-layered (RSC fetches → passes props to client components)
- Components should accept `initialData` for SSR hosts and fall back to SWR fetch for client-only hosts — dual-mode pattern

## System-Wide Impact

### Interaction Graph

- AgentCo renders `<AgentPlaneProvider>` → components call SDK methods via SWR → SDK makes HTTPS requests to AgentPlane API → API queries DB with tenant RLS → response flows back through SWR cache to components
- OAuth flows: component opens popup (synchronously) → popup hits AgentPlane OAuth routes → external provider → callback to AgentPlane → postMessage (origin-validated) to parent → SWR `mutate()` refetches

### Error Propagation

- SDK errors (network, auth, validation) surface as SWR error states in components
- Components use consistent error boundary + toast pattern
- API key / browser token expiration: SDK throws `AgentPlaneError` with 401 → Provider intercepts via SWR's global `onError` and fires `onAuthError` callback to host app
- **Never surface raw SQL or internal error details to client** — API routes already sanitize via `withErrorHandler()`

### State Lifecycle Risks

- **Stale data after mutation**: SWR `mutate()` replaces `router.refresh()` — each mutation call triggers targeted cache invalidation
- **Concurrent editing**: Two tabs editing the same agent. Not a new risk — same as current admin UI. SWR's revalidation on focus helps surface conflicts.
- **Browser token expiry**: Token expires mid-session → SWR requests fail with 401 → `onAuthError` fires → host app refreshes token and updates Provider

### API Surface Parity

- New tenant-scoped endpoints must match the data shape of existing admin endpoints (or the SDK must normalize)
- The library's TypeScript types must align with the SDK's types — since they're in the same monorepo, this is enforced at build time
- SDK declared as `peerDependency` to avoid version duplication

### Integration Test Scenarios

1. AgentCo provisions tenant → mints browser token → initializes SDK → renders `<AgentListPage>` → creates agent → navigates to detail → edits → saves → SWR cache invalidates
2. User connects Composio toolkit via popup OAuth → origin-validated postMessage → SWR refetches → toolkit shows as connected
3. Theme switch in AgentCo → CSS variables change → all embedded components update immediately
4. Browser token expires → SWR request returns 401 → `onAuthError` fires → host app refreshes token → requests resume
5. User navigates between Agent list and Run list → `onNavigate` fires → SWR serves cached data instantly (stale-while-revalidate)
6. Popup blocked by browser → fallback to new tab with return URL → auth completes → redirect back to host

## Acceptance Criteria

### Functional Requirements

- [ ] All 10 page components render correctly when embedded in a non-Next.js React app
- [ ] Components fetch all data via SDK client through SWR (no direct DB queries, no hard-coded fetch URLs)
- [ ] Navigation works via `onNavigate` callback and `LinkComponent` prop (no Next.js dependency)
- [ ] OAuth flows work via popup window pattern with strict origin validation
- [ ] Theming via CSS variables — host app can override colors, radius, fonts
- [ ] AgentPlane's standalone admin UI still works (thin RSC wrappers importing library components)
- [ ] Browser token authentication — raw API keys never reach the browser

### Non-Functional Requirements

- [ ] Bundle size: core entry ~50KB min+gzip; charts (~50KB) and editor (~120KB) in separate entry points
- [ ] No `"use server"` or server-only imports in the published package
- [ ] TypeScript types exported for all component props
- [ ] Works with React 18+ and React 19+
- [ ] `sideEffects: false` for tree-shaking
- [ ] CSS uses `@layer agent-plane` for specificity isolation

### Quality Gates

- [ ] All existing admin UI functionality preserved (no regressions)
- [ ] SDK tests pass for all new endpoints (including browser token)
- [ ] Component test harness renders all pages without errors
- [ ] Published package installs and builds in a clean Vite + React project
- [ ] Package validated with `publint` + `@arethetypeswrong/cli`
- [ ] CI matrix: React 18 + React 19

## Dependencies & Prerequisites

- Phase 1 (API surface + SDK) must complete before Phase 4 (page extraction) can begin
- Phase 2 (primitives) can run in parallel with Phase 1
- Phase 3 (scaffolding) depends on Phase 2 completing
- The existing SDK (`@getcatalystiq/agent-plane`) is stable and covers most CRUD operations
- AgentCo is a React app that can consume an npm package with CSS
- SWR added as a peer dependency for data fetching

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Browser API key exposure** | **Critical** | Implement scoped browser tokens OR proxy pattern (Phase 1) |
| **postMessage origin validation missing** | **High** | Encode host origin in signed OAuth state; validate `event.origin` strictly |
| Server component conversion is larger than expected | High | Audit all pages in Phase 1 before committing; start with simplest (RunListPage) |
| `router.refresh()` replacement is pervasive (25+ sites) | High | Systematic SWR `mutate()` conversion; grep for all `router.refresh()` first |
| COOP header breaks popup in embedded context | Medium | Set `Cross-Origin-Opener-Policy: unsafe-none` on callback routes |
| OAuth popup blocked by browser | Medium | Open popup synchronously in click handler; detect block, fall back to new tab |
| CSS variable theming doesn't cover all visual needs | Medium | Document all variable names; use `@layer` for specificity isolation |
| Bundle size too large for host app | Medium | Mandatory separate entry points for CodeMirror (~120KB) and Recharts (~50KB) |
| Breaking changes in SDK affect library | Low | SDK as peerDependency, same monorepo CI catches at build time |
| Host app has strict CSP | Low | Document required CSP directives; avoid inline styles, use CSS custom properties |

## Future Considerations

- **Dashboard embedding**: AgentCo may want to embed individual widgets (stat cards, charts) rather than full pages — building-block components could be a Phase 2 offering
- **Real-time updates**: SSE support in the library for live run status updates (reuse existing NDJSON streaming)
- **Multi-tenant switcher**: If AgentCo manages multiple AgentPlane tenants, the Provider could support tenant switching via TenantContext
- **Server Components variant**: If AgentCo is also Next.js, a separate RSC-compatible export could offer faster initial loads
- **Framework adapters**: Ship `@getcatalystiq/agent-plane-ui/adapters/next` and `/adapters/react-router` for zero-config navigation setup

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-20-agentco-agentplane-integration-requirements.md](docs/brainstorms/2026-03-20-agentco-agentplane-integration-requirements.md) — Key decisions: component library over iframes, page-level components, explicit tenant provisioning, monorepo with SDK, A2A as universal interface

### Internal References

- SDK build config: `sdk/tsup.config.ts`
- SDK package.json: `sdk/package.json`
- Admin pages: `src/app/admin/(dashboard)/`
- UI primitives: `src/components/ui/`
- Theming: `src/app/globals.css`
- Complex components: `src/components/model-selector.tsx`, `src/components/file-tree-editor.tsx`
- SpecFlow analysis: `docs/analysis/2026-03-20-embeddable-ui-flow-analysis.md`
- OAuth state signing: `src/lib/oauth-state.ts`
- Existing OAuth popup code: `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx`
- Run token generation pattern: `src/lib/crypto.ts:127`

### Research

- Component library best practices: `docs/best-practices-react-component-library.md`
- OAuth popup best practices: `docs/research/oauth-popup-best-practices.md`
- Security audit: `docs/security/embeddable-component-library-audit.md`
- Performance analysis: `docs/component-library-performance-analysis.md`

### Related Work

- Tenant-scoped admin pages refactor: `docs/plans/2026-03-20-001-refactor-tenant-scoped-admin-pages-plan.md`
- Tenant-scoped marketplaces/MCP: `docs/plans/2026-03-20-002-refactor-tenant-scoped-marketplaces-mcp-servers-plan.md`
