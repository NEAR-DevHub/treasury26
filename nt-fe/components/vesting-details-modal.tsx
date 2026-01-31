"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/modal";
import { Button } from "@/components/button";
import { TreasuryAsset } from "@/lib/api";
import { FormattedDate } from "@/components/formatted-date";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { useTreasuryLockup } from "@/hooks/use-lockup";
import { availableBalance } from "@/lib/balance";
import { formatBalance } from "@/lib/utils";
import Big from "big.js";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp } from "lucide-react";

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
        isOpen && treasuryId ? treasuryId : null
    );

    if (!asset || asset.balance.type !== "Vested") return null;

    const lockup = asset.balance.lockup;
    const available = availableBalance(asset.balance);
    const hasStake = lockup.staked.gt(0) || lockup.unstakedBalance.gt(0);

    // Calculate vested percentage
    const vestedPercent = lockup.totalAllocated.gt(0)
        ? lockup.totalAllocated.sub(lockup.unvested).div(lockup.totalAllocated).mul(100).toNumber()
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
                    date={new Date(lockupContract.vestingSchedule.startTimestamp / 1_000_000)}
                    includeTime={false}
                />
            ),
        });
        vestingPeriodItems.push({
            label: "End Date",
            value: (
                <FormattedDate
                    date={new Date(lockupContract.vestingSchedule.endTimestamp / 1_000_000)}
                    includeTime={false}
                />
            ),
        });
    }

    console.log(lockupContract)

    // Token Breakdown items
    const tokenBreakdownItems: InfoItem[] = [
        {
            label: "Original Vested Amount",
            value: `${formatTokenBalance(lockup.totalAllocated)} ${asset.symbol}`,
        },
        {
            label: "Reserved For Storage",
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
    // Pending Release = unstaked balance that cannot be withdrawn yet
    // Available for Withdraw = unstaked balance that can be withdrawn
    const pendingRelease = lockup.canWithdraw ? Big(0) : lockup.unstakedBalance;
    const availableForWithdraw = lockup.canWithdraw ? lockup.unstakedBalance : Big(0);

    const earningOverviewItems: InfoItem[] = hasStake
        ? [
            {
                label: "Staked",
                value: `${formatTokenBalance(lockup.staked)} ${asset.symbol}`,
            },
            {
                label: "Pending Release",
                value: `${formatTokenBalance(pendingRelease)} ${asset.symbol}`,
            },
            {
                label: "Available for Withdraw",
                value: `${formatTokenBalance(availableForWithdraw)} ${asset.symbol}`,
            },
        ]
        : [];

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Vesting Details</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    {/* Available Balance Display */}
                    <div className="bg-muted rounded-lg flex flex-col items-center justify-center gap-2 py-6">
                        <p className="text-sm text-muted-foreground font-medium">Available To Use</p>
                        {asset.icon && (
                            <div className="w-12 h-12 rounded-full bg-background flex items-center justify-center border">
                                <img
                                    src={asset.icon}
                                    alt={asset.symbol}
                                    className="w-10 h-10 rounded-full"
                                />
                            </div>
                        )}
                        <div className="text-center">
                            <span className="text-2xl font-bold">{formatTokenBalance(available)}</span>
                            <span className="text-muted-foreground ml-1">{asset.symbol}</span>
                        </div>
                    </div>

                    {/* Vesting Period */}
                    {isLoading ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-semibold">Vesting Period</h3>
                                <p className="text-xs text-muted-foreground">Tokens unlock daily during this period.</p>
                            </div>
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : vestingPeriodItems.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-semibold">Vesting Period</h3>
                                <p className="text-xs text-muted-foreground">Tokens unlock daily during this period.</p>
                            </div>
                            <InfoDisplay items={vestingPeriodItems} hideSeparator size="sm" />
                        </div>
                    ) : null}

                    {/* Token Breakdown - Collapsible, open by default */}
                    <Collapsible defaultOpen className="">
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">Token Breakdown</h3>
                            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                            <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="flex flex-col">
                            <InfoDisplay items={tokenBreakdownItems} hideSeparator size="sm" />
                        </CollapsibleContent>
                    </Collapsible>

                    {/* Earning Overview - Collapsible, collapsed by default if not staked */}
                    <Collapsible defaultOpen={hasStake}>
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">Earning Overview</h3>
                            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                            <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="flex flex-col gap-2">
                            {hasStake ? (
                                <InfoDisplay items={earningOverviewItems} hideSeparator size="sm" />
                            ) : (
                                <div className="bg-muted/50 rounded-lg p-6 text-center border border-dashed">
                                    <p className="text-sm font-medium">Earn is almost ready!</p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        We're finalizing this feature so you can start earning tokens.
                                    </p>
                                </div>
                            )}
                        </CollapsibleContent>
                    </Collapsible>
                </div>

                <DialogFooter>
                    <Button className="w-full" disabled tooltipContent="Coming soon">
                        Send
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
