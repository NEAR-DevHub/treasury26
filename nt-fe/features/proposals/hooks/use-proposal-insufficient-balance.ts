"use client";

import { useMemo } from "react";
import Big from "@/lib/big";
import { Proposal } from "@/lib/proposals-api";
import { useAssets } from "@/hooks/use-assets";
import { getProposalRequiredFunds } from "../utils/proposal-utils";
import { formatBalance } from "@/lib/utils";
import { availableBalance } from "@/lib/balance";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

export interface InsufficientBalanceInfo {
    hasInsufficientBalance: boolean;
    tokenId?: string;
    tokenSymbol?: string;
    type?: "bond" | "balance" | "no-asset";
    tokenNetwork?: string;
    differenceDisplay?: string;
}

/**
 * Hook to check if a proposal requires more funds than available in treasury
 * @param proposal The proposal to check
 * @param treasuryId The treasury ID to fetch balance for
 * @returns Object with insufficient balance info and loading state
 */
export function useProposalInsufficientBalance(
    proposal: Proposal | null | undefined,
    treasuryId: string | null | undefined,
): {
    data: InsufficientBalanceInfo;
    isLoading: boolean;
} {
    const requiredFunds = useMemo(() => {
        if (!proposal) return null;
        return getProposalRequiredFunds(proposal, treasuryId ?? undefined);
    }, [proposal]);

    const { data: assets, isLoading: isAssetsLoading } = useAssets(treasuryId);

    const insufficientBalanceInfo = useMemo((): InsufficientBalanceInfo => {
        if (assets && requiredFunds) {
            const token = assets.tokens.find(
                (t) =>
                    t.contractId === requiredFunds.tokenId ||
                    (requiredFunds.tokenId.toLowerCase() === NEAR_NETWORK_ID &&
                        t.contractId == null &&
                        t.residency === "Near"),
            );
            if (!token) {
                return {
                    hasInsufficientBalance: true,
                    tokenId: requiredFunds.tokenId,
                    type: "no-asset",
                };
            }

            const requiredBig = Big(requiredFunds.amount || "0");
            const availableBig = availableBalance(token.balance);

            if (requiredBig.gt(availableBig)) {
                return {
                    hasInsufficientBalance: true,
                    tokenId: requiredFunds.tokenId,
                    tokenSymbol: token.symbol,
                    type: "balance",
                    tokenNetwork: token.network,
                    differenceDisplay: formatBalance(
                        requiredBig.sub(availableBig).toString(),
                        token.decimals || 24,
                    ),
                };
            }
        }

        return { hasInsufficientBalance: false };
    }, [requiredFunds, assets]);

    return {
        data: insufficientBalanceInfo,
        isLoading: isAssetsLoading,
    };
}
