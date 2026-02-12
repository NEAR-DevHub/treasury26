"use client";

import { useState } from "react";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useAssets } from "@/hooks/use-assets";

import Assets from "./components/assets";
import BalanceWithGraph from "./components/balance-with-graph";
import { PendingRequests } from "@/features/proposals/components/pending-requests";
import { RecentActivity } from "@/features/activity";
import { OnboardingProgress } from "@/features/onboarding";
import { DepositModal } from "./components/deposit-modal";
import { InfoBox } from "@/features/onboarding/components/info-box";
import { DashboardTour } from "@/features/onboarding/steps/dashboard";
import { useTreasury } from "@/hooks/use-treasury";

export default function AppPage() {
  const { treasuryId } = useTreasury();
  const { data, isLoading, isPending } = useAssets(treasuryId);
  const isAssetsLoading = isLoading || isPending;
  const { tokens, totalBalanceUSD } = data || { tokens: [], totalBalanceUSD: 0 };
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);


  return (
    <PageComponentLayout
      title="Dashboard"
      description="Overview of your treasury assets and activity"
    >
      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex flex-col gap-5 lg:w-3/5 w-full">
          <OnboardingProgress onDepositClick={() => setIsDepositModalOpen(true)} />
          <BalanceWithGraph totalBalanceUSD={totalBalanceUSD} tokens={tokens} onDepositClick={() => setIsDepositModalOpen(true)} isLoading={isAssetsLoading} />
          <Assets tokens={tokens} isLoading={isAssetsLoading} />
          <RecentActivity />
        </div>
        <div className="flex flex-col gap-5 w-full lg:w-2/5">
          <InfoBox />
          <PendingRequests />
        </div>
      </div>

      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
      />
      <DashboardTour />
    </PageComponentLayout>
  );
}
