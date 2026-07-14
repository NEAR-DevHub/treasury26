"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    type BulkActivationStatus,
    getBulkActivationStatus,
    prepareBulkActivation,
} from "@/lib/api";
import { useTreasury } from "@/hooks/use-treasury";

const ACTIVATION_QUERY_KEY = "bulk-activation";

/**
 * Bulk-payment activation state for a confidential treasury.
 *
 * Polls while an activation proposal is awaiting multisig approvals so the
 * UI flips to "active" as soon as the final vote lands (the vote relay
 * authenticates the subaccount with 1Click in the background).
 */
export function useBulkActivation() {
    const { treasuryId, isConfidential } = useTreasury();
    const queryClient = useQueryClient();

    const statusQuery = useQuery<BulkActivationStatus>({
        queryKey: [ACTIVATION_QUERY_KEY, treasuryId],
        queryFn: () => getBulkActivationStatus(treasuryId as string),
        enabled: Boolean(treasuryId && isConfidential),
        staleTime: 10_000,
        refetchInterval: (query) =>
            query.state.data?.status === "awaiting_approval" ? 10_000 : false,
    });

    const prepareMutation = useMutation({
        mutationFn: () => prepareBulkActivation(treasuryId as string),
        onSettled: () => {
            queryClient.invalidateQueries({
                queryKey: [ACTIVATION_QUERY_KEY, treasuryId],
            });
        },
    });

    return {
        status: statusQuery.data?.status,
        bulkAccountId: statusQuery.data?.bulkAccountId,
        pendingPayloadHash: statusQuery.data?.pendingPayloadHash,
        isLoading: statusQuery.isLoading,
        isError: statusQuery.isError,
        isActive: statusQuery.data?.status === "active",
        refetch: statusQuery.refetch,
        prepare: prepareMutation,
    };
}
