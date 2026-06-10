import { useQuery } from "@tanstack/react-query";
import { getAddressBook } from "../api";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";

export function useAddressBook() {
    const { accountId } = useNear();
    const { treasuryId, isGuestTreasury } = useTreasury();
    const enabled = !!treasuryId && !!accountId && !isGuestTreasury;

    return useQuery({
        queryKey: ["address-book", treasuryId, accountId],
        queryFn: () => getAddressBook(treasuryId!),
        enabled,
        staleTime: 1000 * 60, //1 minute
        refetchInterval: 1000 * 60, //1 minute
        refetchIntervalInBackground: true,
    });
}
