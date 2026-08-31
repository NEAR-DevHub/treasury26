"use client";

import { FormattedDate } from "@/components/formatted-date";
import { Skeleton } from "@/components/ui/skeleton";
import { useProposalTransaction, useSwapStatus } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import type { Policy } from "@/types/policy";
import { getProposalStatus } from "../utils/proposal-utils";
import {
    extractReceiptProposalData,
    resolveExecutionTimestamp,
} from "../utils/receipt-utils";

/**
 * When a request last moved. Executed requests prefer the resolved on-chain
 * timestamp — the swap's, when the request settled through one — and fall back
 * to the standard status-based date.
 */
export function ProposalTimelineDate({
    proposal,
    policy,
    className,
}: {
    proposal: Proposal;
    policy: Policy;
    className?: string;
}) {
    const { treasuryId } = useTreasury();
    const status = getProposalStatus(proposal, policy);
    const isProposalExecuted = status === "Executed";
    const depositAddress = extractReceiptProposalData(
        proposal,
        treasuryId,
    )?.depositAddress;
    const shouldUseSwapDate = isProposalExecuted && !!depositAddress;

    const {
        data: transaction,
        isLoading: isLoadingTransaction,
        isAwaitingTransaction,
    } = useProposalTransaction(
        treasuryId,
        proposal,
        policy,
        isProposalExecuted && !shouldUseSwapDate,
    );
    const { data: swapStatus, isLoading: isLoadingSwapStatus } = useSwapStatus(
        depositAddress || null,
        undefined,
        shouldUseSwapDate,
        treasuryId,
    );

    if (!isProposalExecuted) {
        return (
            <FormattedDate
                proposal={proposal}
                policy={policy}
                relative
                className={className}
            />
        );
    }

    const { executedDate, isDateLoading } = resolveExecutionTimestamp({
        swapStatus,
        transaction,
        shouldUseSwapDate,
        isLoadingSwapStatus,
        isLoadingTransaction,
        isAwaitingTransaction,
    });
    if (isDateLoading) {
        return <Skeleton className="h-3.5 w-24" />;
    }

    if (!executedDate) {
        return (
            <FormattedDate
                proposal={proposal}
                policy={policy}
                relative
                className={className}
            />
        );
    }

    return <FormattedDate date={executedDate} relative className={className} />;
}
