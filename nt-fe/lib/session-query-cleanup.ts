import type { QueryClient, QueryKey } from "@tanstack/react-query";

const SESSION_QUERY_PREFIXES = new Set([
    "proposals",
    "proposal",
    "proposal-transaction",
    "quote-by-deposit-address",
    "swap-status",
    "treasuryAssets",
    "balanceChart",
    "recentActivity",
    "recentActivitySenders",
    "recentActivityRecipients",
    "exportHistory",
    "address-book",
    "userTreasuries",
]);

function isSessionQueryKey(queryKey: QueryKey) {
    const [prefix] = queryKey;
    return typeof prefix === "string" && SESSION_QUERY_PREFIXES.has(prefix);
}

export async function clearSessionQueries(queryClient: QueryClient) {
    await queryClient.cancelQueries({
        predicate: (query) => isSessionQueryKey(query.queryKey),
    });
    queryClient.removeQueries({
        predicate: (query) => isSessionQueryKey(query.queryKey),
    });
}
