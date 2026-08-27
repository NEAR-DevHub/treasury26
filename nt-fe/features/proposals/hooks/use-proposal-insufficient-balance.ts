"use client";

import { useMemo } from "react";
import { useAmountFormat } from "@/hooks/use-amount-format";
import { usePublicAssets } from "@/features/confidential/hooks/use-public-assets";
import { useAssets } from "@/hooks/use-assets";
import type { Proposal } from "@/lib/proposals-api";
import {
    getProposalFundingAvailability,
    isFundingInsufficient,
} from "../utils/proposal-funding";
import { getProposalUIKind } from "../utils/proposal-utils";

export interface InsufficientBalanceInfo {
    hasInsufficientBalance: boolean;
    tokenId?: string;
    tokenSymbol?: string;
    /** liquid treasury shortfall → deposit; staked/readyToWithdraw → no deposit */
    type?: "bond" | "balance" | "no-asset" | "staked" | "readyToWithdraw";
    tokenNetwork?: string;
    differenceDisplay?: string;
    /** Whether the UI should offer a Deposit CTA (only for liquid shortfalls). */
    showDeposit?: boolean;
}

/**
 * Hook to check if a proposal requires more funds than available.
 * Staking proposals check staked / ready-to-withdraw balances instead of liquid treasury.
 */
export function useProposalInsufficientBalance(
    proposal: Proposal | null | undefined,
    treasuryId: string | null | undefined,
): {
    data: InsufficientBalanceInfo;
    isLoading: boolean;
} {
    const { data: assets, isLoading: isAssetsLoading } = useAssets(treasuryId);
    const isMoveProposal =
        !!proposal && getProposalUIKind(proposal) === "Move to Confidential";
    const { data: publicAssets } = usePublicAssets({ enabled: isMoveProposal });
    const publicTokens = publicAssets?.tokens;
    const amountFormat = useAmountFormat();

    const insufficientBalanceInfo = useMemo((): InsufficientBalanceInfo => {
        if (!assets || !proposal) {
            return { hasInsufficientBalance: false };
        }

        const funding = getProposalFundingAvailability(
            proposal,
            assets.tokens,
            treasuryId ?? undefined,
            publicTokens,
        );
        if (!funding || !isFundingInsufficient(funding)) {
            return { hasInsufficientBalance: false };
        }

        if (funding.kind === "no-asset") {
            return {
                hasInsufficientBalance: true,
                tokenId: funding.tokenId,
                type: "no-asset",
                showDeposit: true,
            };
        }

        const type =
            funding.kind === "staked"
                ? "staked"
                : funding.kind === "readyToWithdraw"
                  ? "readyToWithdraw"
                  : "balance";

        return {
            hasInsufficientBalance: true,
            tokenId: funding.tokenId,
            tokenSymbol: funding.tokenSymbol,
            type,
            tokenNetwork: funding.tokenNetwork,
            differenceDisplay: amountFormat.rawToken(
                funding.required.sub(funding.available),
                funding.decimals,
                { profile: "standard", rounding: "up" },
            ).display,
            // Unstake/withdraw shortfalls can't be fixed by depositing.
            showDeposit: type === "balance",
        };
    }, [proposal, assets, publicTokens, treasuryId, amountFormat]);

    return {
        data: insufficientBalanceInfo,
        isLoading: isAssetsLoading,
    };
}
