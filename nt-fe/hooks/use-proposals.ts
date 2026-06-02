import { useQuery } from "@tanstack/react-query";
import {
    getProposals,
    ProposalFilters,
    getProposal,
    getProposalTransaction,
    Proposal,
    getSwapStatus,
    getQuoteByDepositAddress,
    getTokenPriceAtTimestamp,
} from "@/lib/proposals-api";
import { isTerminalSwapStatus } from "@/features/proposals/utils/receipt-utils";
import { isAxiosErrorWithStatus } from "@/lib/query-retry";
import { Policy } from "@/types/policy";

/**
 * Query hook to get proposals for a specific DAO with optional filtering
 * Fetches from Sputnik DAO API with support for pagination, sorting, and various filters
 *
 * @param daoId - The DAO account ID to fetch proposals for
 * @param filters - Optional filters for proposals (status, search, types, pagination, etc.)
 *
 * @example
 * ```tsx
 * // Basic usage
 * const { data, isLoading } = useProposals("example.sputnik-dao.near");
 *
 * // With filters
 * const { data } = useProposals("example.sputnik-dao.near", {
 *   statuses: ["InProgress", "Approved"],
 *   page: 0,
 *   page_size: 20,
 *   sort_by: "CreationTime",
 *   sort_direction: "desc"
 * });
 *
 * // With search and type filters
 * const { data } = useProposals("example.sputnik-dao.near", {
 *   search: "funding",
 *   proposal_types: ["Transfer", "FunctionCall"],
 *   proposers: ["alice.near"]
 * });
 * ```
 */
export function useProposals(
    daoId: string | null | undefined,
    filters?: ProposalFilters,
    enabled: boolean = true,
) {
    const filtersKey = filters ? JSON.stringify(filters) : null;
    return useQuery({
        queryKey: ["proposals", daoId, filtersKey],
        queryFn: () => getProposals(daoId!, filters),
        enabled: enabled && !!daoId,
        staleTime: 1000 * 10, // 10 seconds (proposals can change frequently)
    });
}

export function useProposal(
    daoId: string | null | undefined,
    proposalId: string | null | undefined,
) {
    return useQuery({
        queryKey: ["proposal", daoId, proposalId],
        queryFn: () => getProposal(daoId!, proposalId!),
        enabled: !!daoId && !!proposalId,
        staleTime: 1000 * 10, // 10 seconds (proposals can change frequently)
    });
}

export function useProposalTransaction(
    daoId: string | null | undefined,
    proposal: Proposal | null | undefined,
    policy: Policy | null | undefined,
    enabled: boolean = true,
) {
    return useQuery({
        queryKey: [
            "proposal-transaction",
            daoId,
            proposal?.id,
            proposal?.status,
            proposal?.submission_time,
            policy?.proposal_period,
        ],
        queryFn: () => getProposalTransaction(daoId!, proposal!, policy!),
        enabled: enabled && !!daoId && !!proposal && !!policy,
        staleTime: 1000 * 60 * 5, // 5 minutes (transaction data is more stable)
        retry: (failureCount, error) => {
            // Don't retry on 404 (not found) errors
            if (isAxiosErrorWithStatus(error, 404)) {
                return false;
            }
            return failureCount < 3;
        },
    });
}

/**
 * Query hook to get swap execution status for asset exchange proposals
 * Fetches from 1Click API via backend proxy
 *
 * @param depositAddress - The deposit address from the swap quote
 * @param depositMemo - Optional deposit memo if included in quote
 * @param enabled - Whether the query should be enabled (default: true if depositAddress exists)
 *
 */
export function useSwapStatus(
    depositAddress: string | null | undefined,
    depositMemo?: string | null,
    enabled: boolean = true,
) {
    return useQuery({
        queryKey: ["swap-status", depositAddress, depositMemo],
        queryFn: () => getSwapStatus(depositAddress!, depositMemo || undefined),
        enabled: enabled && !!depositAddress,
        staleTime: 1000 * 60, // 1 minute
        refetchInterval: (query) => {
            const data = query.state.data;
            // If status is terminal (SUCCESS, REFUNDED, FAILED), stop polling
            if (isTerminalSwapStatus(data?.status)) {
                return false;
            }
            return 1000 * 60; // 1 minute
        },
        retry: (failureCount, error) => {
            // Don't retry on 404 (deposit address not found)
            if (isAxiosErrorWithStatus(error, 404)) {
                return false;
            }
            return failureCount < 2;
        },
    });
}

export function useQuoteByDepositAddress(
    depositAddress: string | null | undefined,
    depositMemo?: string | null,
    enabled: boolean = true,
) {
    return useQuery({
        queryKey: ["quote-by-deposit-address", depositAddress, depositMemo],
        queryFn: () =>
            getQuoteByDepositAddress(depositAddress!, depositMemo || undefined),
        enabled: enabled && !!depositAddress,
        staleTime: 1000 * 60 * 5,
        retry: (failureCount, error) => {
            if (isAxiosErrorWithStatus(error, 404)) {
                return false;
            }
            return failureCount < 2;
        },
    });
}

export function useTokenPriceAtTimestamp(
    tokenId: string | null | undefined,
    timestamp: string | null | undefined,
    enabled: boolean = true,
) {
    return useQuery({
        queryKey: ["token-price-at-timestamp", tokenId, timestamp],
        queryFn: () => getTokenPriceAtTimestamp(tokenId!, timestamp!),
        enabled: enabled && !!tokenId && !!timestamp,
        staleTime: 1000 * 60 * 5,
        retry: 1,
    });
}
