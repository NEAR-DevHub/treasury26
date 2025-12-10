"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/stores/treasury-store";
import { useWhitelistTokens } from "@/hooks/use-treasury-queries";
import { useMemo } from "react";

import Assets from "./components/assets";
import BalanceWithGraph from "./components/balance-with-graph";

export default function AppPage() {
  const { selectedTreasury: accountId } = useTreasury();
  const { data } = useWhitelistTokens(accountId);
  const { tokens, totalBalanceUSD } = data || { tokens: [], totalBalanceUSD: 0 };


  const filteredTokens = useMemo(() => tokens.filter((token) => token.balance > BigInt(0)), [tokens]);
  return (
    <PageComponentLayout
      title="Dashboard"
      description="Overview of your treasury assets and activity"
    >
      <div className="flex flex-col gap-8">
        <BalanceWithGraph totalBalanceUSD={totalBalanceUSD} tokens={filteredTokens} />

        <Assets tokens={filteredTokens} />
      </div>
    </PageComponentLayout>
  );
}
