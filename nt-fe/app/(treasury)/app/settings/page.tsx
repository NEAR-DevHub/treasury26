"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTreasury, type Treasury } from "@/stores/treasury-store";
import { GeneralTab } from "./components/general-tab";
import { VotingTab } from "./components/voting-tab";
import { PreferencesTab } from "./components/preferences-tab";

// TODO: This should be moved to a shared location or fetched from the treasury store
const treasuries: Treasury[] = [
  { name: "NextCore Solutions", value: "nextcore.sputnikdao.near", balance: 45400.00 },
  { name: "DevHub", value: "devdao.sputnikdao.near", balance: 12500.00 },
  { name: "Nearn-Staging", value: "nearn-staging.sputnikdao.near", balance: 8300.00 },
];

export default function SettingsPage() {
  const { selectedTreasury } = useTreasury();
  const currentTreasury = treasuries.find((t) => t.value === selectedTreasury);

  return (
    <PageComponentLayout title="Settings" description="Adjust your application settings">
      <Tabs defaultValue="general" className="w-full max-w-3xl mx-auto gap-4">
        <TabsList className="rounded-[8px]">
          <TabsTrigger value="general" className="rounded-[8px]">General</TabsTrigger>
          <TabsTrigger value="voting" className="rounded-[8px]">Voting</TabsTrigger>
          <TabsTrigger value="preferences" className="rounded-[8px]">Preferences</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <GeneralTab currentTreasury={currentTreasury} />
        </TabsContent>

        <TabsContent value="voting">
          <VotingTab />
        </TabsContent>

        <TabsContent value="preferences">
          <PreferencesTab />
        </TabsContent>
      </Tabs>
    </PageComponentLayout>
  );
}
