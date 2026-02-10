"use client";

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
import { formatBalance } from "@/lib/utils";
import {
    buildEarningOverviewItems,
    hasStakingActivity,
} from "@/lib/earning-utils";
import Big from "big.js";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
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
        return Big(formatBalance(balance, asset.decimals)).toString();
    };

    // Vesting Period items
    const vestingPeriodItems: InfoItem[] = [];
    if (lockupContract?.vestingSchedule) {
        vestingPeriodItems.push({
            label: "Start Date",
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
            label: "End Date",
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
            label: "Original Vested Amount",
            value: `${formatTokenBalance(lockup.totalAllocated)} ${asset.symbol}`,
        },
        {
            label: "Reserved For Storage",
            info: "A small amount of tokens required to keep the vesting active and cover storage costs.",
            value: `${formatTokenBalance(lockup.storageLocked)} ${asset.symbol}`,
        },
        {
            label: `${vestedPercent.toFixed(0)}% Vested`,
            value: `${formatTokenBalance(vestedAmount)} of ${formatTokenBalance(lockup.totalAllocated)} ${asset.symbol}`,
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
              symbol: asset.symbol,
              formatTokenBalance,
          })
        : [];

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Vesting Details</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    {/* Available Balance Display */}
                    <AmountSummary
                        title="Available To Use"
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
                                    Vesting Period
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                    Tokens unlock daily during this period.
                                </p>
                            </div>
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : vestingPeriodItems.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-semibold">
                                    Vesting Period
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                    Tokens unlock daily during this period.
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
                                Token Breakdown
                            </h3>
                            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                            <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
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
                                Earning Overview
                            </h3>
                            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                            <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
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
                                        <Clock className="size-5 text-muted-foreground" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium">
                                            Earn is almost ready!
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            We're finalizing this feature
                                            <br />
                                            so you can start earning tokens
                                            shortly.
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
                        tooltipContent="Coming soon"
                    >
                        Send
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
