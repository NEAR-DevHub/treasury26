"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface Tab {
  value: string;
  label: string;
  count?: number;
}

interface TabGroupProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (value: string) => void;
}

const toggleGroupItemStyle =
  "h-8 !rounded-full px-3 text-sm font-medium transition-all data-[state=off]:bg-transparent data-[state=off]:text-foreground data-[state=off]:hover:text-foreground/80 data-[state=off]:hover:bg-muted data-[state=on]:!bg-foreground data-[state=on]:!text-primary-foreground data-[state=on]:shadow-none data-[state=on]:!rounded-full";

export function TabGroup({ tabs, activeTab, onTabChange }: TabGroupProps) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-card border shadow-sm p-1">
      <ToggleGroup
        type="single"
        value={activeTab}
        onValueChange={(value) => value && onTabChange(value)}
        className="flex gap-1"
      >
        {tabs.map((tab) => (
          <ToggleGroupItem
            key={tab.value}
            value={tab.value}
            className={toggleGroupItemStyle}
          >
            {tab.label}
            {tab.count !== undefined && (
              <>
                {" "}
                <span
                  className={`px-2 py-0.5 rounded-full text-xs ${activeTab === tab.value
                      ? "bg-background/30 dark:bg-background/30"
                      : "bg-black/20 dark:bg-white/30"
                    }`}
                >
                  {tab.count}
                </span>
              </>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

