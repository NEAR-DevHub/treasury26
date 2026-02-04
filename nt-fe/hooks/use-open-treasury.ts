import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { openTreasury, OpenTreasuryResponse } from "@/lib/api";

/**
 * Hook to open/register a treasury for monitoring
 * Handles automatic registration when a treasury is visited
 * Provides access to credits information and registration status
 *
 * Features:
 * - Session-level deduplication (won't call API twice for same treasury in session)
 * - Caches response in React Query for access across components
 * - Returns mutation for manual triggering if needed
 */
export function useOpenTreasury() {
    const queryClient = useQueryClient();

    // Track opened treasuries in this session to prevent duplicate API calls
    const openedTreasuries = useRef<Set<string>>(new Set());

    const mutation = useMutation({
        mutationFn: (treasuryId: string) => openTreasury(treasuryId),
        onSuccess: (data, treasuryId) => {
            if (data) {
                // Cache the response for other components to access
                queryClient.setQueryData(["treasuryCredits", treasuryId], data);
            }
        },
    });

    /**
     * Open/register a treasury if not already opened in this session
     * Safe to call multiple times - will only make one API call per treasury per session
     */
    const open = useCallback(
        (treasuryId: string | undefined) => {
            if (!treasuryId) return;

            if (!openedTreasuries.current.has(treasuryId)) {
                openedTreasuries.current.add(treasuryId);
                mutation.mutate(treasuryId);
            }
        },
        [mutation],
    );

    /**
     * Get cached credits data for a treasury
     * Returns null if not yet fetched
     */
    const getCredits = useCallback(
        (treasuryId: string | undefined): OpenTreasuryResponse | null => {
            if (!treasuryId) return null;
            return (
                queryClient.getQueryData<OpenTreasuryResponse>([
                    "treasuryCredits",
                    treasuryId,
                ]) ?? null
            );
        },
        [queryClient],
    );

    return {
        /** Open/register a treasury (safe to call multiple times) */
        open,
        /** Get cached credits for a treasury */
        getCredits,
        /** The underlying mutation for advanced usage */
        mutation,
        /** Whether a registration is currently in progress */
        isLoading: mutation.isPending,
        /** The last registration response */
        data: mutation.data,
        /** Whether the last registration was for a new treasury */
        isNewRegistration: mutation.data?.isNewRegistration ?? false,
    };
}
