import Big from "@/lib/big";
import { availableBalance } from "@/lib/balance";
import type { TreasuryAsset } from "@/lib/api";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { Proposal } from "@/lib/proposals-api";
import type { StakingData } from "../types/index";
import { extractProposalData } from "./proposal-extractors";
import { getProposalRequiredFunds } from "./proposal-utils";

export type FundingBalanceKind =
    | "liquid"
    | "staked"
    | "readyToWithdraw"
    | "no-asset";

export interface ProposalFundingAvailability {
    required: Big;
    available: Big;
    kind: FundingBalanceKind;
    tokenId: string;
    tokenSymbol?: string;
    tokenNetwork?: string;
    decimals: number;
}

const STAKE_ACTIONS: StakingData["action"][] = [
    "stake",
    "deposit",
    "deposit_and_stake",
];
const UNSTAKE_ACTIONS: StakingData["action"][] = ["unstake", "unstake_all"];
const WITHDRAW_ACTIONS: StakingData["action"][] = [
    "withdraw",
    "withdraw_all",
    "withdraw_all_from_staking_pool",
];

function findNearLiquidToken(
    tokens: TreasuryAsset[],
): TreasuryAsset | undefined {
    return tokens.find(
        (t) =>
            t.contractId == null &&
            t.residency === "Near" &&
            t.balance.type === "Standard",
    );
}

function findNearTokenById(
    tokens: TreasuryAsset[],
    tokenId: string,
): TreasuryAsset | undefined {
    return tokens.find(
        (t) =>
            t.contractId === tokenId ||
            (tokenId.toLowerCase() === NEAR_NETWORK_ID &&
                t.contractId == null &&
                t.residency === "Near"),
    );
}

function stakingMeta(token: TreasuryAsset | undefined): {
    symbol?: string;
    network?: string;
    decimals: number;
} {
    return {
        symbol: token?.symbol,
        network: token?.network,
        decimals: token?.decimals || 24,
    };
}

/**
 * Resolve how much balance is available for a staking proposal action.
 * - stake/deposit: liquid NEAR (wallet or lockup available)
 * - unstake: staked balance in the target pool / lockup
 * - withdraw: ready-to-withdraw (unstaked + canWithdraw) balance
 */
export function getStakingFundingAvailability(
    tokens: TreasuryAsset[],
    data: StakingData,
): ProposalFundingAvailability {
    const required = Big(data.amount || "0");
    const isStake = STAKE_ACTIONS.includes(data.action);
    const isUnstake = UNSTAKE_ACTIONS.includes(data.action);
    const isWithdraw = WITHDRAW_ACTIONS.includes(data.action);

    if (data.isLockup) {
        const vested = tokens.find((t) => t.balance.type === "Vested");
        const meta = stakingMeta(vested);
        if (!vested || vested.balance.type !== "Vested") {
            return {
                required,
                available: Big(0),
                kind: isStake
                    ? "no-asset"
                    : isUnstake
                      ? "staked"
                      : "readyToWithdraw",
                tokenId: data.tokenId,
                ...meta,
            };
        }
        const lockup = vested.balance.lockup;
        if (isStake) {
            return {
                required,
                available: availableBalance(vested.balance),
                kind: "liquid",
                tokenId: data.tokenId,
                tokenSymbol: vested.symbol,
                tokenNetwork: vested.network,
                decimals: vested.decimals || 24,
            };
        }
        if (isUnstake) {
            return {
                required,
                available: lockup.staked,
                kind: "staked",
                tokenId: data.tokenId,
                tokenSymbol: vested.symbol,
                tokenNetwork: vested.network,
                decimals: vested.decimals || 24,
            };
        }
        if (isWithdraw) {
            return {
                required,
                available: lockup.canWithdraw ? lockup.unstakedBalance : Big(0),
                kind: "readyToWithdraw",
                tokenId: data.tokenId,
                tokenSymbol: vested.symbol,
                tokenNetwork: vested.network,
                decimals: vested.decimals || 24,
            };
        }
    }

    if (isStake) {
        const near = findNearLiquidToken(tokens);
        if (!near) {
            return {
                required,
                available: Big(0),
                kind: "no-asset",
                tokenId: data.tokenId,
                decimals: 24,
            };
        }
        return {
            required,
            available: availableBalance(near.balance),
            kind: "liquid",
            tokenId: data.tokenId,
            tokenSymbol: near.symbol,
            tokenNetwork: near.network,
            decimals: near.decimals || 24,
        };
    }

    const stakedToken = tokens.find((t) => t.balance.type === "Staked");
    const meta = stakingMeta(stakedToken);
    if (!stakedToken || stakedToken.balance.type !== "Staked") {
        return {
            required,
            available: Big(0),
            kind: isUnstake ? "staked" : "readyToWithdraw",
            tokenId: data.tokenId,
            ...meta,
        };
    }

    const pool = stakedToken.balance.staking.pools.find(
        (p) => p.poolId === data.receiver,
    );
    if (!pool) {
        return {
            required,
            available: Big(0),
            kind: isUnstake ? "staked" : "readyToWithdraw",
            tokenId: data.tokenId,
            tokenSymbol: stakedToken.symbol,
            tokenNetwork: stakedToken.network,
            decimals: stakedToken.decimals || 24,
        };
    }

    if (isUnstake) {
        return {
            required,
            available: pool.stakedBalance,
            kind: "staked",
            tokenId: data.tokenId,
            tokenSymbol: stakedToken.symbol,
            tokenNetwork: stakedToken.network,
            decimals: stakedToken.decimals || 24,
        };
    }

    if (isWithdraw) {
        return {
            required,
            available: pool.canWithdraw ? pool.unstakedBalance : Big(0),
            kind: "readyToWithdraw",
            tokenId: data.tokenId,
            tokenSymbol: stakedToken.symbol,
            tokenNetwork: stakedToken.network,
            decimals: stakedToken.decimals || 24,
        };
    }

    return {
        required,
        available: Big(0),
        kind: "no-asset",
        tokenId: data.tokenId,
        ...meta,
    };
}

/**
 * Resolve available vs required funds for any proposal that needs a balance check.
 * Staking proposals use staked / ready-to-withdraw balances where appropriate;
 * other proposals use liquid treasury balance.
 */
export function getProposalFundingAvailability(
    proposal: Proposal,
    tokens: TreasuryAsset[],
    treasuryId?: string,
): ProposalFundingAvailability | null {
    const requiredFunds = getProposalRequiredFunds(proposal, treasuryId);
    if (!requiredFunds) return null;

    const { type: uiKind, data } = extractProposalData(proposal, treasuryId);

    if (
        uiKind === "Earn NEAR" ||
        uiKind === "Unstake NEAR" ||
        uiKind === "Withdraw Earnings"
    ) {
        return getStakingFundingAvailability(tokens, data as StakingData);
    }

    const token =
        findNearTokenById(tokens, requiredFunds.tokenId) ??
        tokens.find((t) => t.contractId === requiredFunds.tokenId);

    if (!token) {
        return {
            required: Big(requiredFunds.amount || "0"),
            available: Big(0),
            kind: "no-asset",
            tokenId: requiredFunds.tokenId,
            decimals: 24,
        };
    }

    return {
        required: Big(requiredFunds.amount || "0"),
        available: availableBalance(token.balance),
        kind: "liquid",
        tokenId: requiredFunds.tokenId,
        tokenSymbol: token.symbol,
        tokenNetwork: token.network,
        decimals: token.decimals || 24,
    };
}

export function isFundingInsufficient(
    funding: ProposalFundingAvailability,
): boolean {
    // Full-amount staking actions encode amount as "0" — nothing to compare.
    if (funding.required.lte(0)) return false;
    if (funding.kind === "no-asset") return true;
    return funding.required.gt(funding.available);
}
