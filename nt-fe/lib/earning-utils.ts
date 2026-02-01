import Big from "big.js";
import { InfoItem } from "@/components/info-display";

interface EarningOverviewParams {
    staked: Big;
    unstakedBalance: Big;
    canWithdraw: boolean;
    symbol: string;
    formatTokenBalance: (balance: Big) => string;
}

/**
 * Builds the earning overview InfoItems for display in modals.
 * Used by both VestingDetailsModal and EarningDetailsModal.
 */
export function buildEarningOverviewItems({
    staked,
    unstakedBalance,
    canWithdraw,
    symbol,
    formatTokenBalance,
}: EarningOverviewParams): InfoItem[] {
    const pendingRelease = canWithdraw ? Big(0) : unstakedBalance;
    const availableForWithdraw = canWithdraw ? unstakedBalance : Big(0);

    return [
        {
            label: "Staked",
            info: "Tokens currently delegated to validators earning rewards.",
            value: `${formatTokenBalance(staked)} ${symbol}`,
        },
        {
            label: "Pending Release",
            info: "Tokens that have been unstaked but are still in the unbonding period (typically 2-3 days).",
            value: `${formatTokenBalance(pendingRelease)} ${symbol}`,
        },
        {
            label: "Available for Withdraw",
            info: "Unstaked tokens that have completed the unbonding period and can be withdrawn.",
            value: `${formatTokenBalance(availableForWithdraw)} ${symbol}`,
        },
    ];
}

/**
 * Checks if there is any staking activity (staked or unstaking balance)
 */
export function hasStakingActivity(staked: Big, unstakedBalance: Big): boolean {
    return staked.gt(0) || unstakedBalance.gt(0);
}
