import { useParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
    useTreasuryConfig,
    useUserTreasuriesWithOptions,
} from "@/hooks/use-treasury-queries";
import { useNear } from "@/stores/near-store";
import { useTreasuryStore } from "@/stores/treasury-store";

/**
 * Resolves the active treasury from the URL, including membership.
 *
 * Membership lookups include hidden treasuries so a member who hid a treasury
 * (Manage Treasuries) still gets member UI when opening it via View Treasury.
 * The returned `treasuries` list excludes hidden ones for selector/picker UX.
 */
export function useTreasury() {
    const params = useParams();
    const { accountId, isInitializing } = useNear();
    const treasuryId = params?.treasuryId as string | undefined;
    const lastTreasuryId = useTreasuryStore((state) => state.lastTreasuryId);
    const setLastTreasuryId = useTreasuryStore(
        (state) => state.setLastTreasuryId,
    );

    // includeHidden: membership must see hidden treasuries; selector list filters them out below.
    const { data: treasuries = [], isLoading: isLoadingTreasuries } =
        useUserTreasuriesWithOptions(accountId, { includeHidden: true });
    const currentTreasury = treasuries.find((t) => t.daoId === treasuryId);
    const visibleTreasuries = useMemo(
        () => treasuries.filter((t) => !t.isHidden),
        [treasuries],
    );

    // For authenticated users, wait for user treasuries before attempting guest lookup.
    // This avoids blocking UI on an unnecessary guest-config request for members.
    const shouldLoadGuestConfig =
        !!treasuryId &&
        !currentTreasury &&
        (!accountId || !isLoadingTreasuries);

    // Fetch config for treasury from URL if it's not in user's list
    const { data: guestTreasuryConfig, isLoading: isLoadingGuestConfig } =
        useTreasuryConfig(shouldLoadGuestConfig ? treasuryId : null);

    // A treasury can be in the list because user saved it, but still be a guest.
    // Logged-out viewers are always guests. While guest config is loading after
    // logout/cache clear, treat as guest so member-only UI/API paths don't flash.
    const isGuestTreasury =
        !!treasuryId &&
        (currentTreasury
            ? !currentTreasury.isMember
            : !accountId ||
              !!guestTreasuryConfig ||
              (shouldLoadGuestConfig && isLoadingGuestConfig));
    const isLoading =
        isInitializing ||
        (accountId ? isLoadingTreasuries : false) ||
        (shouldLoadGuestConfig && isLoadingGuestConfig);
    const treasuryNotFound =
        !isLoading && !!treasuryId && !currentTreasury && !guestTreasuryConfig;
    const isConfidential =
        (currentTreasury?.isConfidential ||
            guestTreasuryConfig?.isConfidential) ??
        false;

    // Store the latest treasury ID when it changes
    useEffect(() => {
        if (treasuryId && !treasuryNotFound) {
            setLastTreasuryId(treasuryId);
        }
    }, [treasuryId, treasuryNotFound, setLastTreasuryId]);

    return {
        isGuestTreasury,
        isSaved: currentTreasury?.isSaved,
        isLoading,
        treasuryId,
        isConfidential,
        lastTreasuryId,
        config: currentTreasury?.config || guestTreasuryConfig,
        treasuries: visibleTreasuries,
        treasuryNotFound,
    };
}
