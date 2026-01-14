import { useQuery } from "@tanstack/react-query";
import { getProposals, ProposalFilters, getProposal, getProposalTransaction, Proposal } from "@/lib/proposals-api";
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
  filters?: ProposalFilters
) {
  return useQuery({
    queryKey: ["proposals", daoId, filters],
    queryFn: () => getProposals(daoId!, filters),
    enabled: !!daoId,
    staleTime: 1000 * 60 * 2, // 2 minutes (proposals can change frequently)
    refetchInterval: 1000 * 60 * 2, // Refetch every 2 minutes
  });
}

export function useProposal(daoId: string | null | undefined, proposalId: string | null | undefined) {
  return useQuery({
    queryKey: ["proposal", daoId, proposalId],
    queryFn: () => getProposal(daoId!, proposalId!),
    enabled: !!daoId && !!proposalId,
    staleTime: 1000 * 60 * 2, // 2 minutes (proposals can change frequently)
    refetchInterval: 1000 * 60 * 2, // Refetch every 2 minutes
  });
}

export function useProposalTransaction(
  daoId: string | null | undefined,
  proposal: Proposal | null | undefined,
  policy: Policy | null | undefined

) {
  return useQuery({
    queryKey: ["proposal-transaction", daoId, proposal?.id, policy],
    queryFn: () => getProposalTransaction(daoId!, proposal!, policy!),
    enabled: !!daoId && !!proposal && !!policy,
    staleTime: 1000 * 60 * 5, // 5 minutes (transaction data is more stable)
    retry: (failureCount, error) => {
      // Don't retry on 404 (not found) errors
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        if (axiosError.response?.status === 404) {
          return false;
        }
      }
      return failureCount < 3;
    },
  });
}
