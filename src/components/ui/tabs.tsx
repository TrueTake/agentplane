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
      <div className="flex gap-1 border-b border-zinc-800">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActive(i)}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px ${
              active === i
                ? "border-b-2 border-white text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-6">{tabs[active].content}</div>
    </div>
  );
}
