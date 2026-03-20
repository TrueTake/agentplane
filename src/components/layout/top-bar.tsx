"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

const ROUTE_LABELS: Record<string, string> = {
  "/admin": "Dashboard",
  "/admin/agents": "Agents",
  "/admin/mcp-servers": "Custom Connectors",
  "/admin/plugin-marketplaces": "Plugins",
  "/admin/runs": "Runs",
  "/admin/settings": "Settings",
};

export function TopBar() {
  const pathname = usePathname();

  // Build breadcrumb segments from pathname
  const segments = pathname.split("/").filter(Boolean); // ["admin", "agents", "abc123"]
  const crumbs: { label: string; href: string }[] = [];

  for (let i = 1; i < segments.length; i++) {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = ROUTE_LABELS[href];
    if (label) {
      crumbs.push({ label, href });
    } else {
      // Detail page — show truncated ID or slug
      const raw = segments[i];
      crumbs.push({ label: raw.length > 12 ? raw.slice(0, 8) + "..." : raw, href });
    }
  }

  // If on /admin exactly, show "Dashboard"
  if (crumbs.length === 0) {
    crumbs.push({ label: "Dashboard", href: "/admin" });
  }

  return (
    <div className="flex items-center h-12 px-6 border-b border-border shrink-0">
      {crumbs.map((crumb, i) => (
        <div key={crumb.href} className="flex items-center">
          {i > 0 && (
            <ChevronRight className="size-3.5 text-muted-foreground mx-2" />
          )}
          {i === crumbs.length - 1 ? (
            <span className="text-sm font-medium text-foreground">
              {crumb.label}
            </span>
          ) : (
            <Link
              href={crumb.href}
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {crumb.label}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
