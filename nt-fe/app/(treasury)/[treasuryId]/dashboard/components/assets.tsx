"use client";

import { Coins, Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import { AssetsTable, AssetsTableSkeleton } from "@/components/assets-table";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { StepperHeader } from "@/components/step-wizard";
import { Tooltip } from "@/components/tooltip";
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
    const { isConfidential } = useTreasury();
    const aggregatedTokens = useAggregatedTokens(tokens);
    const bucketVisibility = getDashboardBucketVisibility(tokens);
    const hasTabs = bucketVisibility.showLocked || bucketVisibility.showEarning;

    const renderContent = () => {
        if (state === "hidden") {
            return <ConfidentialState skeleton={<AssetsTableSkeleton />} />;
        }

        if (state === "loading") {
            return <AssetsTableSkeleton />;
        }

        if (aggregatedTokens.length === 0) {
            return (
                <EmptyState
                    icon={Coins}
                    title={t("noAssetsTitle")}
                    description={t("noAssetsDescription")}
                />
            );
        }

        return <AssetsTable aggregatedTokens={aggregatedTokens} />;
    };

    return (
        <PageCard
            className={
                hasTabs ? "flex flex-col gap-0 p-0" : "flex flex-col gap-5"
            }
        >
            {!hasTabs && (
                <div className="flex justify-between">
                    <StepperHeader
                        title={
                            isConfidential ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <span>{t("title")}</span>
                                    <Tooltip
                                        content={tCommon(
                                            "confidentialDataTooltip",
                                        )}
                                    >
                                        <span className="inline-flex">
                                            <Shield className="size-4 fill-foreground" />
                                        </span>
                                    </Tooltip>
                                </span>
                            ) : (
                                t("title")
                            )
                        }
                    />
                </div>
            )}
            {renderContent()}
        </PageCard>
    );
}
