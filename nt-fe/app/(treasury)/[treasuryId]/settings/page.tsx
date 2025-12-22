"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GeneralTab } from "./components/general-tab";
import { VotingTab } from "./components/voting-tab";
import { PreferencesTab } from "./components/preferences-tab";
import { useState } from "react";

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("general");

  const toggleGroupItemStyle =
    "h-8 !rounded-full px-3 text-sm font-medium transition-all data-[state=off]:bg-transparent data-[state=off]:text-foreground data-[state=off]:hover:text-foreground/80 data-[state=on]:!bg-foreground data-[state=on]:!text-background data-[state=on]:shadow-none data-[state=on]:!rounded-full";
  return (
    <PageComponentLayout
      title="Settings"
      description="Adjust your application settings"
    >
      <div className="w-full max-w-4xl mx-auto px-4">
        <div className="flex mb-6">
          <div className="inline-flex items-center gap-1 rounded-full bg-card border shadow-sm p-1">
            <ToggleGroup
              type="single"
              value={activeTab}
              onValueChange={(value) => value && setActiveTab(value)}
              className="flex gap-1"
            >
              <ToggleGroupItem value="general" className={toggleGroupItemStyle}>
                General
              </ToggleGroupItem>
              <ToggleGroupItem value="voting" className={toggleGroupItemStyle}>
                Voting
              </ToggleGroupItem>
              <ToggleGroupItem
                value="preferences"
                className={toggleGroupItemStyle}
              >
                Preferences
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {activeTab === "general" && <GeneralTab />}
        {activeTab === "voting" && <VotingTab />}
        {activeTab === "preferences" && <PreferencesTab />}
      </div>
    </PageComponentLayout>
  );
}
