"use client";

import { useMemo } from "react";
import { Proposal } from "@/lib/proposals-api";
import { usePublicAssets } from "@/features/confidential/hooks/use-public-assets";
import { useAssets } from "@/hooks/use-assets";
import {
    getProposalFundingAvailability,
    isFundingInsufficient,
} from "../utils/proposal-funding";
import { getProposalUIKind } from "../utils/proposal-utils";

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
    // Public balances only matter for "Move to Confidential" proposals —
    // keep the query (and its re-renders) off for every other list.
    const hasMoveProposal = useMemo(
        () =>
            proposals.some(
                (proposal) =>
                    getProposalUIKind(proposal) === "Move to Confidential",
            ),
        [proposals],
    );
    const { data: publicAssets } = usePublicAssets({
        enabled: hasMoveProposal,
    });
    const publicTokens = publicAssets?.tokens;

    const insufficientBalanceIds = useMemo(() => {
        const ids = new Set<number>();
        if (!assets) return ids;

        for (const proposal of proposals) {
            const funding = getProposalFundingAvailability(
                proposal,
                assets.tokens,
                treasuryId ?? undefined,
                publicTokens,
            );
            if (funding && isFundingInsufficient(funding)) {
                ids.add(proposal.id);
            }
        }
        return ids;
    }, [proposals, assets, publicTokens, treasuryId]);

    return { insufficientBalanceIds, isLoading };
}
