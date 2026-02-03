import { useQuery } from "@tanstack/react-query";
import { getLockupContract, LockupContractInfo } from "@/lib/api";

/**
 * Query hook to get lockup contract information including vesting schedule
 * Fetches from backend which queries the lockup contract on the blockchain
 */
export function useTreasuryLockup(treasuryId: string | null | undefined) {
    return useQuery<LockupContractInfo | null>({
        queryKey: ["lockupContract", treasuryId],
        queryFn: () => getLockupContract(treasuryId!),
        enabled: !!treasuryId,
        staleTime: 1000 * 60 * 10, // 10 minutes - lockup data changes infrequently
    });
}
