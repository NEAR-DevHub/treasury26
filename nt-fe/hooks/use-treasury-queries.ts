import { useQuery } from "@tanstack/react-query";
import { getUserTreasuries } from "@/lib/api";

/**
 * Query hook to get user's treasuries with config data
 * Requires Near instance for blockchain queries
 */
export function useUserTreasuries(
  accountId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["userTreasuries", accountId],
    queryFn: () => getUserTreasuries(accountId!),
    enabled: !!accountId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
