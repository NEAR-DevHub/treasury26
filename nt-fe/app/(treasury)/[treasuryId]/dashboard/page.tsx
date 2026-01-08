"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryAssets } from "@/hooks/use-treasury-queries";

import Assets from "./components/assets";
import BalanceWithGraph from "./components/balance-with-graph";
import { PendingRequests } from "@/features/proposals/components/pending-requests";

export default function AppPage() {
  const { selectedTreasury: accountId } = useTreasury();
  const { data } = useTreasuryAssets(accountId, { onlyPositiveBalance: true });
  const { tokens, totalBalanceUSD } = data || { tokens: [], totalBalanceUSD: 0 };

  return (
    <PageComponentLayout
      title="Dashboard"
      description="Overview of your treasury assets and activity"
    >
      <div className="flex gap-5">
        <div className="flex flex-col gap-5 lg:w-3/5 w-full">
          <BalanceWithGraph totalBalanceUSD={totalBalanceUSD} tokens={tokens} />
          <div className="lg:hidden flex">
            <PendingRequests />
          </div>

          <Assets tokens={tokens} />
        </div>
        <div className="w-2/5 hidden lg:flex">
          <PendingRequests />
        </div>
      </div>
    </PageComponentLayout>
  );
}
