"use client";

import { useMemo } from "react";
import { Proposal } from "@/lib/proposals-api";
import { useAssets } from "@/hooks/use-assets";
import {
    getProposalFundingAvailability,
    isFundingInsufficient,
} from "../utils/proposal-funding";

/**
 * Hook to check which proposals in a list have insufficient balance for approval.
 * Staking proposals check staked / ready-to-withdraw balances instead of liquid treasury.
 */
export function useProposalsInsufficientBalance(
    proposals: Proposal[],
    treasuryId: string | null | undefined,
): {
    insufficientBalanceIds: Set<number>;
    isLoading: boolean;
} {
    const { data: assets, isLoading } = useAssets(treasuryId);

    const insufficientBalanceIds = useMemo(() => {
        const ids = new Set<number>();
        if (!assets) return ids;

        for (const proposal of proposals) {
            const funding = getProposalFundingAvailability(
                proposal,
                assets.tokens,
                treasuryId ?? undefined,
            );
            if (funding && isFundingInsufficient(funding)) {
                ids.add(proposal.id);
            }
        }
        return ids;
    }, [proposals, assets, treasuryId]);

    return { insufficientBalanceIds, isLoading };
}
