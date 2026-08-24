"use client";

import { useTranslations } from "next-intl";
import { AssetsTable, AssetsTableSkeleton } from "@/components/assets-table";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { useIsHistoryRefreshing } from "@/features/activity";
import { useAggregatedTokens } from "@/hooks/use-assets";
import type { TreasuryAsset } from "@/lib/api";

interface Props {
    tokens: TreasuryAsset[];
    state: "loading" | "hidden" | "ready";
}

export default function Assets({ tokens, state }: Props) {
    const t = useTranslations("assetsPage");
    const isHistoryRefreshing = useIsHistoryRefreshing();
    const aggregatedTokens = useAggregatedTokens(tokens);

    const renderContent = () => {
        if (state === "hidden") {
            return (
                <div className="px-3 pb-3">
                    <ConfidentialState skeleton={<AssetsTableSkeleton />} />
                </div>
            );
        }

        if (state === "loading" || isHistoryRefreshing) {
            return (
                <div className="px-3 pb-3">
                    <AssetsTableSkeleton />
                </div>
            );
        }

        if (aggregatedTokens.length === 0) {
            return (
                <div className="px-3 pb-3">
                    <AssetsTableSkeleton
                        overlay={
                            <EmptyState
                                title={t("noAssetsTitle")}
                                description={t("noAssetsDescription")}
                                className="py-0"
                            />
                        }
                    />
                </div>
            );
        }

        return <AssetsTable aggregatedTokens={aggregatedTokens} />;
    };

    return (
        <PageCard className="flex flex-col gap-0 overflow-hidden border-gray-200 bg-gray-50 p-0 dark:border-general-border dark:bg-gray-900">
            {renderContent()}
        </PageCard>
    );
}
