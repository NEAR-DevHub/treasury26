"use client";

import { Icon } from "@/components/icon";
import {
    ArrowDown01Icon,
    ArrowUp01Icon,
    Clock01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/modal";
import { Button } from "@/components/button";
import { TreasuryAsset } from "@/lib/api";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { formatBalance } from "@/lib/utils";
import {
    buildEarningOverviewItems,
    hasStakingActivity,
} from "@/lib/earning-utils";
import Big from "@/lib/big";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AmountSummary } from "./amount-summary";

interface EarningDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    asset: TreasuryAsset | null;
}

export function EarningDetailsModal({
    isOpen,
    onClose,
    asset,
}: EarningDetailsModalProps) {
    const t = useTranslations("earningDetails");
    if (!asset || asset.balance.type !== "Staked") return null;

    const staking = asset.balance.staking;
    const totalStaked = staking.stakedBalance.add(staking.unstakedBalance);
    const hasStake = hasStakingActivity(
        staking.stakedBalance,
        staking.unstakedBalance,
    );

    // Format balances
    const formatTokenBalance = (balance: Big) => {
        return Big(formatBalance(balance, asset.decimals)).toString();
    };

    // Earning Overview items using shared function
    const earningOverviewItems = buildEarningOverviewItems({
        staked: staking.stakedBalance,
        unstakedBalance: staking.unstakedBalance,
        canWithdraw: staking.canWithdraw,
        symbol: asset.symbol,
        formatTokenBalance,
        labels: {
            staked: t("overview.staked"),
            stakedInfo: t("overview.stakedInfo"),
            pendingRelease: t("overview.pendingRelease"),
            pendingReleaseInfo: t("overview.pendingReleaseInfo"),
            availableForWithdraw: t("overview.availableForWithdraw"),
            availableForWithdrawInfo: t("overview.availableForWithdrawInfo"),
        },
    });

    // Per-pool breakdown items - show staked and unstaking separately
    const poolBreakdownItems: InfoItem[] = staking.pools.flatMap((pool) => {
        const items: InfoItem[] = [
            {
                label: pool.poolId,
                value: `${formatTokenBalance(pool.stakedBalance)} ${asset.symbol}`,
            },
        ];
        if (pool.unstakedBalance.gt(0)) {
            items.push({
                label: pool.canWithdraw ? t("readyToWithdraw") : t("unstaking"),
                subItem: true,
                value: `${formatTokenBalance(pool.unstakedBalance)} ${asset.symbol}`,
            });
        }
        return items;
    });

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t("title")}</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    <AmountSummary
                        title={t("totalStaked")}
                        total={formatTokenBalance(totalStaked)}
                        totalUSD={asset.balanceUSD}
                        token={{
                            address: asset.contractId || "",
                            symbol: asset.symbol,
                            decimals: asset.decimals,
                            name: asset.name,
                            icon: asset.icon,
                            network: asset.network,
                        }}
                    />

                    {/* Earning Overview - Always open */}
                    <Collapsible defaultOpen>
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">
                                {t("earningOverview")}
                            </h3>
                            <Icon
                                icon={ArrowDown01Icon}
                                className="text-muted-foreground transition-transform group-data-[state=open]:hidden"
                            />
                            <Icon
                                icon={ArrowUp01Icon}
                                className="text-muted-foreground transition-transform group-data-[state=closed]:hidden"
                            />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="flex flex-col">
                            <InfoDisplay
                                items={earningOverviewItems}
                                hideSeparator
                                size="sm"
                            />
                        </CollapsibleContent>
                    </Collapsible>

                    {/* Pool Breakdown - Collapsible */}
                    {staking.pools.length > 1 && (
                        <Collapsible defaultOpen={false}>
                            <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                                <h3 className="text-sm font-semibold">
                                    {t("poolBreakdown", {
                                        count: staking.pools.length,
                                    })}
                                </h3>
                                <Icon
                                    icon={ArrowDown01Icon}
                                    className="text-muted-foreground transition-transform group-data-[state=open]:hidden"
                                />
                                <Icon
                                    icon={ArrowUp01Icon}
                                    className="text-muted-foreground transition-transform group-data-[state=closed]:hidden"
                                />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="flex flex-col">
                                <InfoDisplay
                                    items={poolBreakdownItems}
                                    hideSeparator
                                    size="sm"
                                />
                            </CollapsibleContent>
                        </Collapsible>
                    )}

                    {/* Coming Soon Placeholder */}
                    {!hasStake && (
                        <div className="py-1.5 text-center flex flex-col items-center gap-2">
                            <div className="bg-muted rounded-full p-2 text-center">
                                <Icon
                                    icon={Clock01Icon}
                                    className="text-muted-foreground"
                                />
                            </div>
                            <div>
                                <p className="text-sm font-medium">
                                    {t("almostReady")}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {t.rich("finalizingFeature", {
                                        br: () => <br />,
                                    })}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        className="w-full"
                        disabled
                        tooltipContent={t("comingSoon")}
                    >
                        {t("goToEarn")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
