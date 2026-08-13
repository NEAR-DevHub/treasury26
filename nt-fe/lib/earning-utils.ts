import type { ReactNode } from "react";
import type { InfoItem } from "@/components/info-display";
import Big from "@/lib/big";

interface EarningOverviewParams {
    staked: Big;
    unstakedBalance: Big;
    canWithdraw: boolean;
    formatTokenBalance: (balance: Big) => ReactNode;
    labels: {
        staked: string;
        stakedInfo: string;
        pendingRelease: string;
        pendingReleaseInfo: string;
        availableForWithdraw: string;
        availableForWithdrawInfo: string;
    };
}

/**
 * Builds the earning overview InfoItems for display in modals.
 * Used by both VestingDetailsModal and EarningDetailsModal.
 */
export function buildEarningOverviewItems({
    staked,
    unstakedBalance,
    canWithdraw,
    formatTokenBalance,
    labels,
}: EarningOverviewParams): InfoItem[] {
    const pendingRelease = canWithdraw ? Big(0) : unstakedBalance;
    const availableForWithdraw = canWithdraw ? unstakedBalance : Big(0);

    return [
        {
            label: labels.staked,
            info: labels.stakedInfo,
            value: formatTokenBalance(staked),
        },
        {
            label: labels.pendingRelease,
            info: labels.pendingReleaseInfo,
            value: formatTokenBalance(pendingRelease),
        },
        {
            label: labels.availableForWithdraw,
            info: labels.availableForWithdrawInfo,
            value: formatTokenBalance(availableForWithdraw),
        },
    ];
}

/**
 * Checks if there is any staking activity (staked or unstaking balance)
 */
export function hasStakingActivity(staked: Big, unstakedBalance: Big): boolean {
    return staked.gt(0) || unstakedBalance.gt(0);
}
