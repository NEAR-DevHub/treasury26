"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { useTreasury, } from "@/stores/treasury-store";
import { GeneralTab } from "./components/general-tab";
import { VotingTab } from "./components/voting-tab";
import { PreferencesTab } from "./components/preferences-tab";

export default function SettingsPage() {
  const { treasury } = useTreasury();

  return (
    <PageComponentLayout title="Settings" description="Adjust your application settings">
      <Tabs defaultValue="general" className="w-full max-w-3xl mx-auto gap-4">
        <TabsList >
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="voting">Voting</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        <TabsContents>
          <TabsContent value="general">
            <GeneralTab currentTreasury={treasury || undefined} />
          </TabsContent>

          <TabsContent value="voting">
            <VotingTab />
          </TabsContent>

          <TabsContent value="preferences">
            <PreferencesTab />
          </TabsContent>
        </TabsContents>
      </Tabs>
    </PageComponentLayout >
  );
}
