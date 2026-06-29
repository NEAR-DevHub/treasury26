import { useQuery } from "@tanstack/react-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { getProposalTemplates } from "../api";

/** Fetch the current treasury's proposal templates (gated on a signed-in, non-guest treasury). */
export function useProposalTemplates() {
    const { accountId } = useNear();
    const { treasuryId, isGuestTreasury } = useTreasury();
    const enabled = !!treasuryId && !!accountId && !isGuestTreasury;

    return useQuery({
        queryKey: ["proposal-templates", treasuryId, accountId],
        queryFn: () => getProposalTemplates(treasuryId as string),
        enabled,
        staleTime: 1000 * 10,
    });
}
