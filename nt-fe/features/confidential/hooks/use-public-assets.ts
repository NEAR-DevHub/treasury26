"use client";

import { useQuery } from "@tanstack/react-query";
import { useTreasury } from "@/hooks/use-treasury";
import { getConfidentialPublicAssets, type TreasuryAssets } from "@/lib/api";
import { useNear } from "@/stores/near-store";

export const PUBLIC_ASSETS_QUERY_KEY = "confidential-public-assets";

/**
 * Liquid public balances of a confidential treasury (funds that landed on the
 * DAO account / public intents instead of the confidential balance).
 * Member-only — disabled for guests and public treasuries.
 */
export function usePublicAssets() {
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const { accountId } = useNear();

    return useQuery<TreasuryAssets>({
        queryKey: [PUBLIC_ASSETS_QUERY_KEY, treasuryId],
        queryFn: () => getConfidentialPublicAssets(treasuryId as string),
        enabled: Boolean(
            treasuryId && isConfidential && !isGuestTreasury && accountId,
        ),
        staleTime: 30_000,
        refetchInterval: 60_000,
    });
}
