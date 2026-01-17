import { useParams } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useUserTreasuries, useTreasuryConfig } from "@/hooks/use-treasury-queries";

/**
 * Hook to determine if the current user is viewing a treasury as a guest
 * (i.e., the treasury is not in their list of treasuries they have access to)
 */
export function useIsGuestTreasury() {
    const params = useParams();
    const { accountId } = useNear();
    const treasuryId = params?.treasuryId as string | undefined;

    const { data: treasuries = [], isLoading: isLoadingTreasuries } = useUserTreasuries(accountId);
    const currentTreasury = treasuries.find(t => t.daoId === treasuryId);

    // Fetch config for treasury from URL if it's not in user's list
    const { data: guestTreasuryConfig, isLoading: isLoadingGuestConfig } = useTreasuryConfig(
        treasuryId && !currentTreasury ? treasuryId : null
    );

    const isGuestTreasury = !!(treasuryId && !currentTreasury && guestTreasuryConfig);
    const isLoading = isLoadingTreasuries || isLoadingGuestConfig;

    return {
        isGuestTreasury,
        isLoading,
        treasuryId,
        currentTreasury,
        guestTreasuryConfig,
        treasuries,
    };
}

