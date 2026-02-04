import { useQuery } from "@tanstack/react-query";
import { searchReceipt, ReceiptSearchResult } from "@/lib/api";

/**
 * Hook to search for a receipt by keyword and get the originating transaction hash
 * Uses React Query with long stale time since receipt->transaction mappings are immutable
 */
export function useReceiptSearch(keyword: string | undefined) {
    return useQuery({
        queryKey: ["receiptSearch", keyword],
        queryFn: async (): Promise<ReceiptSearchResult[]> => {
            if (!keyword) return [];
            return searchReceipt(keyword);
        },
        enabled: !!keyword,
        staleTime: 1000 * 60 * 60, // 1 hour - receipts are immutable
        gcTime: 1000 * 60 * 60 * 24, // 24 hours
    });
}
