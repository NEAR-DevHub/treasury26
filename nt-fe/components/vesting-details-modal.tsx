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
import { FormattedDate } from "@/components/formatted-date";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { useTreasuryLockup } from "@/hooks/use-lockup";
import { availableBalance } from "@/lib/balance";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import {
    buildEarningOverviewItems,
    hasStakingActivity,
} from "@/lib/earning-utils";
import Big from "@/lib/big";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AmountSummary } from "./amount-summary";

interface VestingDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    asset: TreasuryAsset | null;
    treasuryId: string | null;
}

export function VestingDetailsModal({
    isOpen,
    onClose,
    asset,
    treasuryId,
}: VestingDetailsModalProps) {
    const t = useTranslations("vestingDetails");
    const tEarning = useTranslations("earningDetails");
    const { data: lockupContract, isLoading } = useTreasuryLockup(
        isOpen && treasuryId ? treasuryId : null,
    );

    if (!asset || asset.balance.type !== "Vested") return null;

    const lockup = asset.balance.lockup;
    const available = availableBalance(asset.balance);
    const hasStake = hasStakingActivity(lockup.staked, lockup.unstakedBalance);

    // Calculate vested percentage
    const vestedPercent = lockup.totalAllocated.gt(0)
        ? lockup.totalAllocated
              .sub(lockup.unvested)
              .div(lockup.totalAllocated)
              .mul(100)
              .toNumber()
        : 0;

    const vestedAmount = lockup.totalAllocated.sub(lockup.unvested);

    // Format balances
    const formatTokenBalance = (balance: Big) => {
        return decimalFromBaseUnits(balance, asset.decimals).toFixed();
    };

    // Vesting Period items
    const vestingPeriodItems: InfoItem[] = [];
    if (lockupContract?.vestingSchedule) {
        vestingPeriodItems.push({
            label: t("startDate"),
            value: (
                <FormattedDate
                    date={
                        new Date(
                            lockupContract.vestingSchedule.startTimestamp /
                                1_000_000,
                        )
                    }
                    includeTime={false}
                />
            ),
        });
        vestingPeriodItems.push({
            label: t("endDate"),
            value: (
                <FormattedDate
                    date={
                        new Date(
                            lockupContract.vestingSchedule.endTimestamp /
                                1_000_000,
                        )
                    }
                    includeTime={false}
                />
            ),
        });
    }

    // Token Breakdown items
    const tokenBreakdownItems: InfoItem[] = [
        {
            label: t("originalVestedAmount"),
            value: `${formatTokenBalance(lockup.totalAllocated)} ${asset.symbol}`,
        },
        {
            label: t("reservedForStorage"),
            info: t("reservedForStorageInfo"),
            value: `${formatTokenBalance(lockup.storageLocked)} ${asset.symbol}`,
        },
        {
            label: t("percentVested", {
                percent: vestedPercent.toFixed(0),
            }),
            value: t("vestedOf", {
                vested: formatTokenBalance(vestedAmount),
                total: formatTokenBalance(lockup.totalAllocated),
                symbol: asset.symbol,
            }),
            afterValue: (
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div
                        className="bg-primary h-full rounded-full transition-all"
                        style={{ width: `${vestedPercent}%` }}
                    />
                </div>
            ),
        },
    ];

    // Earning Overview items (only shown if has stake)
    const earningOverviewItems = hasStake
        ? buildEarningOverviewItems({
              staked: lockup.staked,
              unstakedBalance: lockup.unstakedBalance,
              canWithdraw: lockup.canWithdraw,
              formatTokenBalance,
              labels: {
                  staked: tEarning("overview.staked"),
                  stakedInfo: tEarning("overview.stakedInfo"),
                  pendingRelease: tEarning("overview.pendingRelease"),
                  pendingReleaseInfo: tEarning("overview.pendingReleaseInfo"),
                  availableForWithdraw: tEarning(
                      "overview.availableForWithdraw",
                  ),
                  availableForWithdrawInfo: tEarning(
                      "overview.availableForWithdrawInfo",
                  ),
              },
          })
        : [];

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>{t("title")}</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    {/* Available Balance Display */}
                    <AmountSummary
                        title={t("availableToUse")}
                        total={formatTokenBalance(available)}
                        totalUSD={available
                            .mul(asset.price)
                            .div(Big(10).pow(asset.decimals))
                            .toNumber()}
                        token={{
                            address: asset.contractId || "",
                            symbol: asset.symbol,
                            decimals: asset.decimals,
                            name: asset.name,
                            icon: asset.icon,
                            network: asset.network,
                        }}
                    />

                    {/* Vesting Period */}
                    {isLoading ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-semibold">
                                    {t("vestingPeriod")}
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                    {t("vestingPeriodDescription")}
                                </p>
                            </div>
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : vestingPeriodItems.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-semibold">
                                    {t("vestingPeriod")}
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                    {t("vestingPeriodDescription")}
                                </p>
                            </div>
                            <InfoDisplay
                                items={vestingPeriodItems}
                                hideSeparator
                                size="sm"
                            />
                        </div>
                    ) : null}

                    {/* Token Breakdown - Collapsible, open by default */}
                    <Collapsible defaultOpen className="">
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">
                                {t("tokenBreakdown")}
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
                                items={tokenBreakdownItems}
                                hideSeparator
                                size="sm"
                            />
                        </CollapsibleContent>
                    </Collapsible>

                    {/* Earning Overview - Collapsible, collapsed by default if not staked */}
                    <Collapsible defaultOpen={hasStake}>
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">
                                {tEarning("earningOverview")}
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
                        <CollapsibleContent className="flex flex-col gap-2">
                            {hasStake ? (
                                <InfoDisplay
                                    items={earningOverviewItems}
                                    hideSeparator
                                    size="sm"
                                />
                            ) : (
                                <div className="py-1.5 text-center flex flex-col items-center gap-2">
                                    <div className="bg-muted rounded-full p-2 text-center">
                                        <Icon
                                            icon={Clock01Icon}
                                            className="text-muted-foreground"
                                        />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium">
                                            {tEarning("almostReady")}
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {tEarning.rich(
                                                "finalizingFeature",
                                                { br: () => <br /> },
                                            )}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </CollapsibleContent>
                    </Collapsible>
                </div>

                <DialogFooter>
                    <Button
                        className="w-full"
                        disabled
                        tooltipContent={tEarning("comingSoon")}
                    >
                        {t("send")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
