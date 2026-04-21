"use client";

import { type ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function AgentTabs({
  general,
  identity,
  runs,
  connectors,
  skills,
  plugins,
  schedules,
  triggers,
}: {
  general: ReactNode;
  identity: ReactNode;
  runs: ReactNode;
  connectors: ReactNode;
  skills: ReactNode;
  plugins: ReactNode;
  schedules: ReactNode;
  triggers: ReactNode;
}) {
  return (
    <Tabs
      tabs={[
        { label: "General", content: general },
        { label: "Identity", content: identity },
        { label: "Connectors", content: connectors },
        { label: "Skills", content: skills },
        { label: "Plugins", content: plugins },
        { label: "Schedules", content: schedules },
        { label: "Triggers", content: triggers },
        { label: "Runs", content: runs },
      ]}
    />
  );
}
