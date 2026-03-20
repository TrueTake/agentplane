# @getcatalystiq/agent-plane-ui

Embeddable React component library for [AgentPlane](https://github.com/getcatalystiq/agent-plane). Drop full-featured agent management pages into any React app — agents, runs, MCP servers, plugins, settings, and dashboards.

Built on the [`@getcatalystiq/agent-plane`](https://www.npmjs.com/package/@getcatalystiq/agent-plane) SDK for data fetching and [SWR](https://swr.vercel.app/) for caching and revalidation.

## Installation

```bash
npm install @getcatalystiq/agent-plane-ui @getcatalystiq/agent-plane swr
```

Peer dependencies:
- `react` ^18 or ^19
- `react-dom` ^18 or ^19
- `@getcatalystiq/agent-plane` (SDK)
- `swr` ^2

Optional peer dependencies (only needed if you use the corresponding entry points):
- `recharts` ^2 — required for `@getcatalystiq/agent-plane-ui/charts`
- `react-markdown` ^9 — required for transcript rendering in `RunDetailPage`

## Quick Start

```tsx
import { AgentPlane } from "@getcatalystiq/agent-plane";
import { AgentPlaneProvider, AgentListPage } from "@getcatalystiq/agent-plane-ui";

const client = new AgentPlane({
  baseUrl: "https://your-agentplane.vercel.app",
  apiKey: "ap_browser_...", // browser token — see "Browser Token Authentication" below
});

function App() {
  return (
    <AgentPlaneProvider
      client={client}
      onNavigate={(path) => window.location.assign(path)}
    >
      <AgentListPage />
    </AgentPlaneProvider>
  );
}
```

## Provider Configuration

Wrap your app (or the AgentPlane section) with `<AgentPlaneProvider>`:

```tsx
<AgentPlaneProvider
  client={client}
  onNavigate={handleNavigate}
  LinkComponent={MyLink}
  onAuthError={handleAuthError}
  basePath="/admin/agentplane"
>
  {children}
</AgentPlaneProvider>
```

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `client` | `AgentPlaneClient` | Yes | An instance of the `AgentPlane` SDK client. |
| `onNavigate` | `(path: string) => void` | Yes | Called when a component needs to navigate. The `path` is relative (e.g. `/agents/ag_123`). |
| `LinkComponent` | `React.ComponentType<LinkComponentProps>` | No | Custom link component for in-app navigation. Defaults to `<a>`. |
| `onAuthError` | `(error: Error) => void` | No | Called on 401/403 responses. Use this to refresh browser tokens or redirect to login. |
| `basePath` | `string` | No | Path prefix prepended to all navigation paths. For example, if your AgentPlane pages live at `/admin/agentplane/agents`, set `basePath` to `"/admin/agentplane"`. Defaults to `""`. |

### LinkComponentProps

```ts
interface LinkComponentProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}
```

## Navigation Setup

### React Router

```tsx
import { useNavigate, Link } from "react-router-dom";

function AgentPlaneLayout() {
  const navigate = useNavigate();

  return (
    <AgentPlaneProvider
      client={client}
      onNavigate={(path) => navigate(path)}
      LinkComponent={({ href, children, className }) => (
        <Link to={href} className={className}>{children}</Link>
      )}
      basePath="/agentplane"
    >
      <Outlet />
    </AgentPlaneProvider>
  );
}
```

### Next.js App Router

```tsx
"use client";

import { useRouter } from "next/navigation";
import NextLink from "next/link";

function AgentPlaneLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <AgentPlaneProvider
      client={client}
      onNavigate={(path) => router.push(path)}
      LinkComponent={({ href, children, className }) => (
        <NextLink href={href} className={className}>{children}</NextLink>
      )}
      basePath="/admin/agentplane"
    >
      {children}
    </AgentPlaneProvider>
  );
}
```

## Theming

Components use CSS custom properties (variables) for theming. Define them on your root element or a wrapper `<div>`. The library ships with no default styles — you provide the theme.

### CSS Variable Contract

```css
:root {
  /* Base colors — used for page backgrounds and primary text */
  --background: 0 0% 100%;       /* page background (hsl channels) */
  --foreground: 0 0% 3.9%;       /* primary text */

  /* Card surfaces */
  --card: 0 0% 100%;             /* card background */
  --card-foreground: 0 0% 3.9%;  /* card text */

  /* Primary — buttons, links, active states */
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;

  /* Secondary — secondary buttons, subtle backgrounds */
  --secondary: 0 0% 96.1%;
  --secondary-foreground: 0 0% 9%;

  /* Muted — disabled states, subtle text, placeholders */
  --muted: 0 0% 96.1%;
  --muted-foreground: 0 0% 45.1%;

  /* Accent — hover states, highlights */
  --accent: 0 0% 96.1%;
  --accent-foreground: 0 0% 9%;

  /* Destructive — error states, delete buttons */
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;

  /* Borders, inputs, focus rings */
  --border: 0 0% 89.8%;
  --input: 0 0% 89.8%;
  --ring: 0 0% 3.9%;

  /* Border radius */
  --radius: 0.5rem;
}
```

### Dark Mode

Apply the `.dark` class to a parent element to switch to dark mode:

```css
.dark {
  --background: 0 0% 3.9%;
  --foreground: 0 0% 98%;
  --card: 0 0% 7%;
  --card-foreground: 0 0% 98%;
  --primary: 0 0% 98%;
  --primary-foreground: 0 0% 9%;
  --secondary: 0 0% 14.9%;
  --secondary-foreground: 0 0% 98%;
  --muted: 0 0% 14.9%;
  --muted-foreground: 0 0% 63.9%;
  --accent: 0 0% 14.9%;
  --accent-foreground: 0 0% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 14.9%;
  --input: 0 0% 14.9%;
  --ring: 0 0% 83.1%;
}
```

```tsx
<div className="dark">
  <AgentPlaneProvider {...props}>
    <AgentListPage />
  </AgentPlaneProvider>
</div>
```

## Available Components

### Page Components

These are full-page components that handle data fetching, loading states, error handling, and mutations internally.

| Component | Description |
|-----------|-------------|
| `DashboardPage` | Overview dashboard with stat cards and run/cost charts. |
| `AgentListPage` | Paginated agent list with search, create, and delete. |
| `AgentDetailPage` | Agent detail view with tabbed sections (edit, connectors, skills, plugins, schedule, runs, A2A). |
| `RunListPage` | Paginated run list with status filtering and source badges. |
| `RunDetailPage` | Run detail with full transcript viewer, cancel button, and metadata. |
| `McpServerListPage` | MCP server management (list, create, delete). |
| `PluginMarketplaceListPage` | Plugin marketplace list. |
| `PluginMarketplaceDetailPage` | Marketplace detail with plugin browser and file editor. |
| `SettingsPage` | Tenant settings (API keys, budget, timezone). |

### Agent Sub-Components

These are used internally by `AgentDetailPage` but are also exported for custom layouts:

| Component | Description |
|-----------|-------------|
| `AgentEditForm` | Agent configuration form (name, model, tools, permissions). |
| `AgentConnectorsManager` | Composio and MCP connector management. |
| `AgentSkillManager` | Skill CRUD for an agent. |
| `AgentPluginManager` | Plugin installation/removal. |
| `AgentScheduleForm` | Schedule configuration (cron, timezone). |
| `AgentRuns` | Run history for a specific agent. |
| `AgentA2aInfo` | A2A protocol info (endpoint URLs, Agent Card preview). |

### Charts (Separate Entry Point)

Import from `@getcatalystiq/agent-plane-ui/charts` to keep Recharts (~50KB) out of your main bundle:

```tsx
import { RunCharts } from "@getcatalystiq/agent-plane-ui/charts";

<RunCharts data={dailyStats} />
```

| Component | Description |
|-----------|-------------|
| `RunCharts` | Line charts for runs/day and cost/day per agent. Accepts `DailyAgentStat[]`. |

### Editor (Separate Entry Point)

Import from `@getcatalystiq/agent-plane-ui/editor` for CodeMirror-based components. This keeps CodeMirror (~120KB) out of the core bundle. Currently a placeholder for future phases.

### UI Primitives

Low-level building blocks are also exported for custom pages:

`Button`, `Card`, `Badge`, `Input`, `Select`, `Textarea`, `FormField`, `FormError`, `SectionHeader`, `DetailPageHeader`, `Skeleton`, `MetricCard`, `AdminTable`, `PaginationBar`, `Tabs`, `Dialog`, `ConfirmDialog`, `CopyButton`, `RunStatusBadge`, `RunSourceBadge`, `LocalDate`, `ModelSelector`, `ToolkitMultiselect`

### Hooks

| Hook | Description |
|------|-------------|
| `useAgentPlaneClient()` | Returns the SDK client from the nearest provider. |
| `useAuthError()` | Returns the `onAuthError` callback (if set). |
| `useNavigation()` | Returns `{ onNavigate, LinkComponent, basePath }` from the nearest provider. |
| `useApi(key, fetcher, options?)` | SWR wrapper that injects the SDK client into the fetcher. Pass `null` as key to skip fetching. |

```tsx
import { useApi } from "@getcatalystiq/agent-plane-ui";

function MyComponent() {
  const { data, error, isLoading } = useApi(
    "agents",
    (client) => client.agents.list(),
  );

  if (isLoading) return <Skeleton />;
  if (error) return <div>Error: {error.message}</div>;
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

## Browser Token Authentication

Raw API keys (`ap_live_...`) must never be exposed in client-side code. Use short-lived browser tokens instead.

### Server-Side: Mint a Token

```ts
// In your API route or server component
import { AgentPlane } from "@getcatalystiq/agent-plane";

const serverClient = new AgentPlane({
  baseUrl: "https://your-agentplane.vercel.app",
  apiKey: process.env.AGENT_PLANE_API_KEY!, // secret, server-only
});

const { token, expires_at } = await serverClient.keys.createBrowserToken({
  scopes: ["agents:read", "agents:write", "runs:read", "runs:write"],
  ttl_seconds: 3600, // optional, defaults to 1 hour
});
```

### Client-Side: Use the Token

```tsx
"use client";

import { AgentPlane } from "@getcatalystiq/agent-plane";
import { AgentPlaneProvider, AgentListPage } from "@getcatalystiq/agent-plane-ui";
import { useState, useEffect } from "react";

function AgentPlaneApp() {
  const [client, setClient] = useState<AgentPlane | null>(null);

  useEffect(() => {
    fetch("/api/agentplane-token")
      .then((r) => r.json())
      .then(({ token }) => {
        setClient(
          new AgentPlane({
            baseUrl: "https://your-agentplane.vercel.app",
            apiKey: token,
          }),
        );
      });
  }, []);

  if (!client) return <div>Loading...</div>;

  return (
    <AgentPlaneProvider
      client={client}
      onNavigate={(path) => window.location.assign(path)}
      onAuthError={(error) => {
        // Token expired — refresh it
        console.error("Auth error:", error);
        window.location.reload();
      }}
    >
      <AgentListPage />
    </AgentPlaneProvider>
  );
}
```

### Token Refresh Pattern

For long-lived sessions, refresh the token before it expires:

```tsx
function useAgentPlaneToken() {
  const [token, setToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/agentplane-token");
    const { token } = await res.json();
    setToken(token);
  }, []);

  useEffect(() => {
    refresh();
    // Refresh every 50 minutes (token lasts 60)
    const interval = setInterval(refresh, 50 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { token, refresh };
}
```

## Bundle Size

The library uses three separate entry points to minimize bundle size:

| Entry Point | Approx. Size | Includes |
|---|---|---|
| `@getcatalystiq/agent-plane-ui` | ~55KB min | All pages, UI primitives, hooks |
| `@getcatalystiq/agent-plane-ui/charts` | ~4KB min (+Recharts peer) | `RunCharts` |
| `@getcatalystiq/agent-plane-ui/editor` | placeholder | CodeMirror editor (future) |

## License

MIT
