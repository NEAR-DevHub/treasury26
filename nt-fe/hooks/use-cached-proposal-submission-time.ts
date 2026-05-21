"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { Proposal } from "@/lib/proposals-api";

type CachedProposalSummary = Pick<Proposal, "id" | "submission_time">;
interface CachedProposalsQueryData {
    proposals?: CachedProposalSummary[];
}

export function useCachedProposalSubmissionTime(
    treasuryId: string | undefined,
    proposalId: string,
): string | null {
    const queryClient = useQueryClient();

    const getSnapshot = () => {
        if (!treasuryId || !proposalId) {
            return null;
        }

        const cachedQueries = queryClient.getQueriesData({
            queryKey: ["proposals", treasuryId],
        });

        for (const [, queryData] of cachedQueries) {
            const proposals = (
                queryData as CachedProposalsQueryData | undefined
            )?.proposals;
            if (!proposals?.length) continue;

            const matchedProposal = proposals.find(
                (cachedProposal) => String(cachedProposal.id) === proposalId,
            );
            if (matchedProposal?.submission_time) {
                return matchedProposal.submission_time;
            }
        }

        return null;
    };

    return useSyncExternalStore(
        (onStoreChange) => queryClient.getQueryCache().subscribe(onStoreChange),
        getSnapshot,
        getSnapshot,
    );
}
