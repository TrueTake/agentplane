---
date: 2026-03-20
topic: agentco-agentplane-integration
---

# AgentCo + AgentPlane Deep Integration

## Problem Frame

AgentCo (multi-agent coordination platform) and AgentPlane (single-agent execution engine) are separate codebases connected only via A2A protocol. This creates operational overhead (two deployments, two auth systems, two DBs), product fragmentation (users see two systems), and limits the ability to build unified features. We want to converge them into one product experience while keeping clean architectural separation.

## Requirements

- R1. AgentPlane ships a published React component library (`@getcatalystiq/agent-plane-ui`) that exports page-level components for embedding into AgentCo's UI.
- R2. Page components fill the content area next to AgentCo's sidebar. AgentCo owns the shell (sidebar, top bar, auth), AgentPlane components own everything inside the content area.
- R3. All admin pages are exposed as embeddable components:
  - R3a. Agent list page
  - R3b. Agent detail page (tabbed: General, Connectors, Skills, Plugins, Schedules, Runs)
  - R3c. Run list page
  - R3d. Run detail page (transcript viewer)
  - R3e. MCP servers list + detail
  - R3f. Plugin marketplaces list + detail (with plugin editor)
  - R3g. Settings page (company config, API keys)
- R4. AgentCo provisions AgentPlane tenants via the existing `@getcatalystiq/agent-plane` SDK. AgentCo stores the `tenant_id` and `api_key` mapping per company.
- R5. The component library accepts an SDK client instance (initialized with the tenant's API key) as configuration. All API calls flow through this client.
- R6. Components accept theming configuration (CSS variables or theme prop) so they visually match AgentCo's design system.
- R7. A2A remains the interface between AgentCo's orchestration layer and AgentPlane's execution layer — both for internal dispatch and external callers.
- R8. AgentPlane continues to run as a separate app with its own deployment. No codebase merge.

## Success Criteria

- An AgentCo user can manage agents, runs, connectors, plugins, MCP servers, and settings without ever leaving AgentCo's UI.
- External A2A clients can still discover and invoke AgentPlane agents directly (A2A interface preserved).
- AgentPlane's admin UI and the embedded components share the same source code (no duplication).

## Scope Boundaries

- AgentCo's sidebar, navigation, auth, and company management are out of scope — AgentCo owns those.
- No codebase merge — AgentPlane stays as a separate repo and deployment.
- No changes to A2A protocol or AgentPlane's REST API.
- AgentCo-side integration work (sidebar items, tenant provisioning flow, credential storage) is AgentCo's concern, not part of this requirements doc.
- Multi-agent orchestration features (task breakdown, delegation, handoffs) stay in AgentCo.

## Key Decisions

- **Component library over iframes**: Both apps are Next.js + Tailwind. A component library gives native feel, shared theming, and proper routing integration. Iframes would create styling seams and require postMessage plumbing.
- **Page-level components over building blocks**: AgentCo wants to drop full pages into routes, not assemble from primitives. Reduces integration surface and lets AgentPlane own the UX for agent management.
- **Explicit tenant provisioning over auto-provisioning**: AgentCo calls the SDK to create tenants and stores credentials. Simple, uses existing API, no new auth mechanisms needed.
- **Separate app preserved**: AgentPlane stays independently deployable. The component library is an additional published package, not a replacement for the standalone admin UI.
- **A2A as universal interface**: A2A serves both as the internal contract (AgentCo orchestrator → AgentPlane execution) and the external API (third-party agents → AgentPlane). This prevents tight coupling while keeping the execution layer open.

## Dependencies / Assumptions

- AgentCo is a React/Next.js app that can consume a React component library.
- The existing `@getcatalystiq/agent-plane` SDK covers all API operations the components need (CRUD for agents, runs, connectors, MCP servers, plugins, sessions).
- AgentPlane's admin UI components can be extracted from the app without hard dependencies on Next.js App Router internals (layouts, server components, etc.).

## Outstanding Questions

### Deferred to Planning
- [Affects R6][Needs research] What theming approach works best — CSS variables injected by AgentCo, a ThemeProvider wrapper, or Tailwind config sharing? Depends on AgentCo's current styling setup.
- [Affects R3][Technical] Which components currently use Next.js server components or server actions? These will need to be converted to client components with SDK-based data fetching.
- [Affects R2][Technical] How should routing work inside page components? React Router nested routes, or internal state-based navigation (tabs, modals) that doesn't affect the URL?
- [Affects R5][Technical] Should the SDK client be passed via React context (Provider pattern) or as a direct prop to each page component?
- [Affects R3g][User decision] Should the embedded settings page show the full tenant config (including API keys), or should some fields be hidden since AgentCo manages auth?

## Next Steps

-> `/ce:plan` for structured implementation planning.
