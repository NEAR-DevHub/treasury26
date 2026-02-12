"use client";

import { useMemo } from "react";
import Big from "big.js";
import { Proposal } from "@/lib/proposals-api";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { getProposalRequiredFunds } from "../utils/proposal-utils";
import { formatBalance } from "@/lib/utils";

export interface InsufficientBalanceInfo {
    hasInsufficientBalance: boolean;
    tokenSymbol?: string;
    type?: "bond" | "balance";
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
        return getProposalRequiredFunds(proposal);
    }, [proposal]);

    const { data: tokenData, isLoading: isTokenLoading } = useToken(
        requiredFunds?.tokenId,
    );
    const { data: tokenBalanceData, isLoading: isTokenBalanceLoading } =
        useTokenBalance(treasuryId, requiredFunds?.tokenId, tokenData?.network);

    const insufficientBalanceInfo = useMemo((): InsufficientBalanceInfo => {
        if (tokenBalanceData && requiredFunds) {
            const requiredBig = Big(requiredFunds?.amount || "0");
            const availableBig = Big(tokenBalanceData?.balance || "0");

            if (requiredBig.gt(availableBig) && tokenData) {
                return {
                    hasInsufficientBalance: true,
                    tokenSymbol: tokenData?.symbol,
                    type: "balance",
                    tokenNetwork: tokenData?.network,
                    differenceDisplay: formatBalance(
                        requiredBig.sub(availableBig).toString(),
                        tokenData?.decimals || 24,
                    ),
                };
            }
        }

        return { hasInsufficientBalance: false };
    }, [requiredFunds, tokenBalanceData, tokenData]);

    return {
        data: insufficientBalanceInfo,
        isLoading: isTokenLoading || isTokenBalanceLoading,
    };
}
