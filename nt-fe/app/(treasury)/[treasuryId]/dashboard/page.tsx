"use client";

import { useState } from "react";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasuryAssets } from "@/hooks/use-treasury-queries";

import Assets from "./components/assets";
import BalanceWithGraph from "./components/balance-with-graph";
import { PendingRequests } from "@/features/proposals/components/pending-requests";
import { RecentActivity } from "./components/recent-activity";
import { OnboardingProgress } from "@/features/onboarding";
import { DepositModal } from "./components/deposit-modal";
import { InfoBox } from "@/features/onboarding/components/info-box";
import { DashboardTour } from "@/features/onboarding/steps/dashboard";
import { useTreasury } from "@/stores/treasury-store";

export default function AppPage() {
  const { selectedTreasury } = useTreasury();
  const { data, isLoading, isPending } = useTreasuryAssets(selectedTreasury);
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
          <BalanceWithGraph totalBalanceUSD={totalBalanceUSD} tokens={tokens} onDepositClick={() => setIsDepositModalOpen(true)} isLoading={isAssetsLoading} />
          <OnboardingProgress onDepositClick={() => setIsDepositModalOpen(true)} />
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
