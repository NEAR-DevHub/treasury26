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

export default function AppPage() {
  const { data } = useTreasuryAssets(undefined, { onlyPositiveBalance: true });
  const { tokens, totalBalanceUSD } = data || { tokens: [], totalBalanceUSD: 0 };
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);


  return (
    <PageComponentLayout
      title="Dashboard"
      description="Overview of your treasury assets and activity"
    >
      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex flex-col gap-5 lg:w-3/5 w-full">
          <BalanceWithGraph totalBalanceUSD={totalBalanceUSD} tokens={tokens} onDepositClick={() => setIsDepositModalOpen(true)} />
          <OnboardingProgress onDepositClick={() => setIsDepositModalOpen(true)} />
          <Assets tokens={tokens} />
          <RecentActivity />
        </div>
        <div className="w-full lg:w-2/5">
          <PendingRequests />
        </div>
      </div>

      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
      />
    </PageComponentLayout>
  );
}
