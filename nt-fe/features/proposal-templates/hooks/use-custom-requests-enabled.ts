import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { getCustomRequestsEnabled, setCustomRequestsEnabled } from "../api";

function customRequestsKey(
    treasuryId: string | undefined,
    accountId: string | null | undefined,
) {
    return ["custom-requests-enabled", treasuryId, accountId] as const;
}

/**
 * Whether the Custom Requests feature is on for the current treasury. Gates the sidebar's Request
 * Templates section and the Developer settings card. Same enable-conditions as the templates query
 * (signed-in, non-guest treasury).
 */
export function useCustomRequestsEnabled() {
    const { accountId } = useNear();
    const { treasuryId, isGuestTreasury } = useTreasury();
    const enabled = !!treasuryId && !!accountId && !isGuestTreasury;

    return useQuery({
        queryKey: customRequestsKey(treasuryId, accountId),
        queryFn: () => getCustomRequestsEnabled(treasuryId as string),
        enabled,
        staleTime: 1000 * 30,
    });
}

/** Flip the Custom Requests flag (ChangePolicy-gated server-side), then refresh the cached value. */
export function useSetCustomRequestsEnabled() {
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (nextEnabled: boolean) =>
            setCustomRequestsEnabled(treasuryId as string, nextEnabled),
        onSuccess: (resolvedEnabled) => {
            queryClient.setQueryData(
                customRequestsKey(treasuryId, accountId),
                resolvedEnabled,
            );
        },
    });
}
