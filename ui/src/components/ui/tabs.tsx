"use client";

import { useState, type ReactNode } from "react";

interface Tab {
  label: string;
  content: ReactNode;
}

export function Tabs({ tabs, defaultTab = 0 }: { tabs: Tab[]; defaultTab?: number }) {
  const [active, setActive] = useState(defaultTab);

  return (
    <div>
      <div className="flex gap-4">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActive(i)}
            className={`relative pb-2 text-sm font-medium transition-colors ${
              active === i
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {active === i && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        ))}
      </div>
      <div className="pt-6">{tabs[active]?.content}</div>
    </div>
  );
}
