"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/modal";
import { Button } from "@/components/button";
import { TreasuryAsset } from "@/lib/api";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { formatBalance } from "@/lib/utils";
import { buildEarningOverviewItems, hasStakingActivity } from "@/lib/earning-utils";
import Big from "big.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";

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
    if (!asset || asset.balance.type !== "Staked") return null;

    const staking = asset.balance.staking;
    const totalStaked = staking.stakedBalance.add(staking.unstakedBalance);
    const hasStake = hasStakingActivity(staking.stakedBalance, staking.unstakedBalance);

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
                label: pool.canWithdraw ? "└ Ready to withdraw" : "└ Unstaking",
                value: `${formatTokenBalance(pool.unstakedBalance)} ${asset.symbol}`,
            });
        }
        return items;
    });

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Earning Details</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    {/* Total Staked Display */}
                    <div className="bg-muted rounded-lg flex flex-col items-center justify-center gap-2 py-6">
                        <p className="text-sm text-muted-foreground font-medium">Total Staked</p>
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
                            <span className="text-2xl font-bold">{formatTokenBalance(totalStaked)}</span>
                            <span className="text-muted-foreground ml-1">{asset.symbol}</span>
                        </div>
                    </div>

                    {/* Earning Overview - Always open */}
                    <Collapsible defaultOpen>
                        <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                            <h3 className="text-sm font-semibold">Earning Overview</h3>
                            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                            <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="flex flex-col">
                            <InfoDisplay items={earningOverviewItems} hideSeparator size="sm" />
                        </CollapsibleContent>
                    </Collapsible>

                    {/* Pool Breakdown - Collapsible */}
                    {staking.pools.length > 1 && (
                        <Collapsible defaultOpen={false}>
                            <CollapsibleTrigger className="w-full flex items-center justify-between py-2 group">
                                <h3 className="text-sm font-semibold">Pool Breakdown ({staking.pools.length} pools)</h3>
                                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:hidden" />
                                <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:hidden" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="flex flex-col">
                                <InfoDisplay items={poolBreakdownItems} hideSeparator size="sm" />
                            </CollapsibleContent>
                        </Collapsible>
                    )}

                    {/* Coming Soon Placeholder */}
                    {!hasStake && (
                        <div className="py-1.5 text-center flex flex-col items-center gap-2">
                            <div className="bg-muted rounded-full p-2 text-center">
                                <Clock className="size-5 text-muted-foreground" />
                            </div>
                            <div>
                                <p className="text-sm font-medium">Earn is almost ready!</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    We're finalizing this feature<br />so you can start earning tokens shortly.
                                </p>
                            </div>
                        </div>
                    )}
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
