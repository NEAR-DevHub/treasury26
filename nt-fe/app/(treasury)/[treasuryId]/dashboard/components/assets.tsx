"use client";

import { Coins, Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import { AssetsTable, AssetsTableSkeleton } from "@/components/assets-table";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { Tooltip } from "@/components/tooltip";
import { useIsHistoryRefreshing } from "@/features/activity";
import { useAggregatedTokens } from "@/hooks/use-assets";
import { useTreasury } from "@/hooks/use-treasury";
import type { TreasuryAsset } from "@/lib/api";
import { getDashboardBucketVisibility } from "@/lib/dashboard-balance-view";

interface Props {
    tokens: TreasuryAsset[];
    state: "loading" | "hidden" | "ready";
}

export default function Assets({ tokens, state }: Props) {
    const t = useTranslations("assetsPage");
    const tCommon = useTranslations("common");
    const { isConfidential, isGuestTreasury } = useTreasury();
    const isHistoryRefreshing = useIsHistoryRefreshing();
    const aggregatedTokens = useAggregatedTokens(tokens);
    const bucketVisibility = getDashboardBucketVisibility(tokens);
    const hasTabs = bucketVisibility.showLocked || bucketVisibility.showEarning;
    const showConfidentialShield = isConfidential && !isGuestTreasury;

    const renderContent = () => {
        if (state === "hidden") {
            return (
                <div className="px-4 pb-4">
                    <ConfidentialState skeleton={<AssetsTableSkeleton />} />
                </div>
            );
        }

        if (state === "loading" || isHistoryRefreshing) {
            return (
                <div className="px-4 pb-4">
                    <AssetsTableSkeleton />
                </div>
            );
        }

        if (aggregatedTokens.length === 0) {
            return (
                <div className="px-4 pb-4">
                    <EmptyState
                        icon={Coins}
                        title={t("noAssetsTitle")}
                        description={t("noAssetsDescription")}
                    />
                </div>
            );
        }

        return <AssetsTable aggregatedTokens={aggregatedTokens} />;
    };

    return (
        <PageCard className="flex flex-col gap-0 overflow-hidden p-0">
            {!hasTabs && (
                <div className="flex justify-between px-4 pt-4 pb-3">
                    <h2 className="flex items-center gap-1.5 font-bold text-2xl tracking-tight">
                        {t("title")}
                        {showConfidentialShield && (
                            <Tooltip
                                content={tCommon("confidentialDataTooltip")}
                            >
                                <span className="inline-flex">
                                    <Shield className="size-4 fill-foreground" />
                                </span>
                            </Tooltip>
                        )}
                    </h2>
                </div>
            )}
            {renderContent()}
        </PageCard>
    );
}
