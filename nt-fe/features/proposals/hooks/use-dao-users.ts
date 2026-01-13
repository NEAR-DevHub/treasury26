import { useQuery } from "@tanstack/react-query";
import { getDaoProposers, getDaoApprovers } from "@/lib/proposals-api";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { useMemo } from "react";

export type UserListType = "members" | "proposers" | "approvers";

/**
 * Unified hook to fetch different types of user lists for a DAO
 * @param daoId - The DAO/treasury ID
 * @param type - The type of users to fetch: "members", "proposers", or "approvers"
 * @returns Object containing users array and loading state
 */
export function useDaoUsers(daoId: string | null, type: UserListType) {
  // For members, use the existing treasury members hook
  const { members, isLoading: isMembersLoading } = useTreasuryMembers(
    type === "members" ? daoId : null
  );

  // For proposers
  const {
    data: proposers = [],
    isLoading: isProposersLoading,
  } = useQuery({
    queryKey: ["dao-proposers", daoId],
    queryFn: () => getDaoProposers(daoId!),
    enabled: !!daoId && type === "proposers",
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // For approvers
  const {
    data: approvers = [],
    isLoading: isApproversLoading,
  } = useQuery({
    queryKey: ["dao-approvers", daoId],
    queryFn: () => getDaoApprovers(daoId!),
    enabled: !!daoId && type === "approvers",
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Convert members to array of account IDs for consistent return type
  const memberAccountIds = useMemo(
    () => members.map((m) => m.accountId),
    [members]
  );

  // Return the appropriate data based on type
  const users = useMemo(() => {
    switch (type) {
      case "members":
        return memberAccountIds;
      case "proposers":
        return proposers;
      case "approvers":
        return approvers;
      default:
        return [];
    }
  }, [type, memberAccountIds, proposers, approvers]);

  const isLoading = useMemo(() => {
    switch (type) {
      case "members":
        return isMembersLoading;
      case "proposers":
        return isProposersLoading;
      case "approvers":
        return isApproversLoading;
      default:
        return false;
    }
  }, [type, isMembersLoading, isProposersLoading, isApproversLoading]);

  return { users, isLoading };
}
