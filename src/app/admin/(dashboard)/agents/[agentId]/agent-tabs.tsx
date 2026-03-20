"use client";

import { type ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function AgentTabs({
  general,
  connectors,
  pluginsAndSkills,
  schedules,
}: {
  general: ReactNode;
  connectors: ReactNode;
  pluginsAndSkills: ReactNode;
  schedules: ReactNode;
}) {
  return (
    <Tabs
      tabs={[
        { label: "General", content: general },
        { label: "Connectors", content: connectors },
        { label: "Plugins & Skills", content: pluginsAndSkills },
        { label: "Schedules", content: schedules },
      ]}
    />
  );
}
