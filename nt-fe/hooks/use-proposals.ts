import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import {
    getProposals,
    ProposalFilters,
    ProposalsResponse,
    getProposal,
    getProposalTransaction,
    Proposal,
    getSwapStatus,
    getQuoteByDepositAddress,
    getTokenPriceAtTimestamp,
} from "@/lib/proposals-api";
import { isTerminalSwapStatus } from "@/features/proposals/utils/receipt-utils";
import { useTreasury } from "@/hooks/use-treasury";
import { isAxiosErrorWithStatus } from "@/lib/query-retry";
import { Policy } from "@/types/policy";

function useCanReadProposalQueries(daoId: string | null | undefined) {
    const {
        treasuryId,
        isConfidential,
        isGuestTreasury,
        isLoading,
        treasuryNotFound,
    } = useTreasury();

    if (!daoId || daoId !== treasuryId) {
        return true;
    }

    if (isLoading || treasuryNotFound) {
        return false;
    }

    return !(isConfidential && isGuestTreasury);
}

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
    options?: {
        refetchInterval?:
            | number
            | false
            | ((query: Query<ProposalsResponse>) => number | false);
        refetchOnMount?: boolean | "always";
    },
) {
    const canReadProposalQueries = useCanReadProposalQueries(daoId);
    const filtersKey = filters ? JSON.stringify(filters) : null;
    return useQuery({
        queryKey: ["proposals", daoId, filtersKey],
        queryFn: () => getProposals(daoId!, filters),
        enabled: enabled && canReadProposalQueries && !!daoId,
        staleTime: 1000 * 10, // 10 seconds (proposals can change frequently)
        refetchOnMount: options?.refetchOnMount,
        refetchInterval: options?.refetchInterval,
    });
}

export function useProposal(
    daoId: string | null | undefined,
    proposalId: string | null | undefined,
) {
    const canReadProposalQueries = useCanReadProposalQueries(daoId);
    return useQuery({
        queryKey: ["proposal", daoId, proposalId],
        queryFn: () => getProposal(daoId!, proposalId!),
        enabled: canReadProposalQueries && !!daoId && !!proposalId,
        staleTime: 1000 * 10, // 10 seconds (proposals can change frequently)
    });
}

/** NearBlocks indexes shortly after execution — poll until the tx appears. */
const PROPOSAL_TX_POLL_MS = 5_000;
const PROPOSAL_TX_MAX_POLLS = 12; // ~1 minute

export function useProposalTransaction(
    daoId: string | null | undefined,
    proposal: Proposal | null | undefined,
    policy: Policy | null | undefined,
    enabled: boolean = true,
) {
    const queryClient = useQueryClient();
    const canReadProposalQueries = useCanReadProposalQueries(daoId);
    // Only executed proposals (on-chain Approved) have an execution tx to wait
    // for. Rejected/Removed should surface N/A rather than keep polling.
    const expectsTransaction =
        proposal?.status === "Approved" || proposal?.status === "Failed";
    const isQueryEnabled =
        enabled && canReadProposalQueries && !!daoId && !!proposal && !!policy;
    const queryKey = [
        "proposal-transaction",
        daoId,
        proposal?.id,
        proposal?.status,
        proposal?.submission_time,
        policy?.proposal_period,
    ] as const;

    const query = useQuery({
        queryKey,
        queryFn: () => getProposalTransaction(daoId!, proposal!, policy!),
        enabled: isQueryEnabled,
        staleTime: 1000 * 60 * 5, // 5 minutes once we have the transaction
        refetchInterval: (q) => {
            // Keep polling while NearBlocks has not indexed the execution tx yet.
            if (!expectsTransaction) return false;
            if (q.state.data) return false;
            if (q.state.dataUpdateCount >= PROPOSAL_TX_MAX_POLLS) return false;
            return PROPOSAL_TX_POLL_MS;
        },
        retry: (failureCount, error) => {
            // Don't retry on 404 (not found) errors — polling handles indexer lag.
            if (isAxiosErrorWithStatus(error, 404)) {
                return false;
            }
            return failureCount < 3;
        },
    });

    const dataUpdateCount =
        queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;

    // True while we still expect a transaction (including between poll intervals),
    // so callers can show a skeleton instead of "N/A".
    const isAwaitingTransaction =
        isQueryEnabled &&
        expectsTransaction &&
        !query.data &&
        (query.isLoading ||
            query.isFetching ||
            dataUpdateCount < PROPOSAL_TX_MAX_POLLS);

    return { ...query, isAwaitingTransaction };
}

/**
 * Query hook to get swap execution status for asset exchange proposals
 * Fetches from 1Click API via backend proxy
 *
 * @param depositAddress - The deposit address from the swap quote
 * @param depositMemo - Optional deposit memo if included in quote
 * @param enabled - Whether the query should be enabled (default: true if depositAddress exists)
 * @param daoId - Treasury/DAO id. The backend uses it to decide the status
 *   source: confidential treasuries read from our bronze history table, others
 *   use 1Click `/v0/status`.
 *
 */
export function useSwapStatus(
    depositAddress: string | null | undefined,
    depositMemo?: string | null,
    enabled: boolean = true,
    daoId?: string | null,
) {
    return useQuery({
        queryKey: ["swap-status", depositAddress, depositMemo, daoId],
        queryFn: () =>
            getSwapStatus(
                depositAddress!,
                depositMemo || undefined,
                daoId || undefined,
            ),
        enabled: enabled && !!depositAddress,
        staleTime: 1000 * 10, // 10 seconds
        refetchInterval: (query) => {
            const data = query.state.data;
            // If status is terminal (SUCCESS, REFUNDED, FAILED), stop polling
            if (isTerminalSwapStatus(data?.status)) {
                return false;
            }
            return 1000 * 10; // 10 seconds
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
