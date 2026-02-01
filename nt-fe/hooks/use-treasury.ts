import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useTreasuryStore } from "@/stores/treasury-store";
import { useUserTreasuries, useTreasuryConfig } from "@/hooks/use-treasury-queries";

/**
 * Hook to determine if the current user is viewing a treasury as a guest
 * (i.e., the treasury is not in their list of treasuries they have access to)
 */
export function useTreasury() {
    const params = useParams();
    const { accountId, isInitializing } = useNear();
    const treasuryId = params?.treasuryId as string | undefined;
    const lastTreasuryId = useTreasuryStore((state) => state.lastTreasuryId);
    const setLastTreasuryId = useTreasuryStore((state) => state.setLastTreasuryId);

    const { data: treasuries = [], isLoading: isLoadingTreasuries } = useUserTreasuries(accountId);
    const currentTreasury = treasuries.find(t => t.daoId === treasuryId);

    // Fetch config for treasury from URL if it's not in user's list
    const { data: guestTreasuryConfig, isLoading: isLoadingGuestConfig } = useTreasuryConfig(
        treasuryId && !currentTreasury ? treasuryId : null
    );

    const isGuestTreasury = !!(treasuryId && !currentTreasury && guestTreasuryConfig);
    const isLoading = isLoadingTreasuries || isLoadingGuestConfig || isInitializing;
    const treasuryNotFound = !isLoading && !!treasuryId && !currentTreasury && !guestTreasuryConfig;

    // Store the latest treasury ID when it changes
    useEffect(() => {
        if (treasuryId && !treasuryNotFound) {
            setLastTreasuryId(treasuryId);
        }
    }, [treasuryId, treasuryNotFound, setLastTreasuryId]);

    return {
        isGuestTreasury,
        isLoading,
        treasuryId,
        lastTreasuryId,
        config: currentTreasury?.config || guestTreasuryConfig,
        treasuries,
        treasuryNotFound,
    };
}
