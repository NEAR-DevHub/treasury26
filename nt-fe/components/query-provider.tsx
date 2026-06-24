"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import { clearSessionQueries } from "@/lib/session-query-cleanup";
import { useNearStore } from "@/stores/near-store";

function getAuthenticatedSessionAccount(
    state: ReturnType<typeof useNearStore.getState>,
) {
    if (
        state.isAuthenticated &&
        state.hasAcceptedTerms &&
        !!state.walletAccountId
    ) {
        return state.walletAccountId;
    }
    return null;
}

function SessionQueryCleanup({ queryClient }: { queryClient: QueryClient }) {
    useEffect(() => {
        let previousSessionAccount = getAuthenticatedSessionAccount(
            useNearStore.getState(),
        );

        return useNearStore.subscribe((state) => {
            const sessionAccount = getAuthenticatedSessionAccount(state);
            if (
                previousSessionAccount &&
                previousSessionAccount !== sessionAccount
            ) {
                void clearSessionQueries(queryClient);
            }
            previousSessionAccount = sessionAccount;
        });
    }, [queryClient]);

    return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 1000 * 5, // 5 seconds
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );

    return (
        <QueryClientProvider client={queryClient}>
            <SessionQueryCleanup queryClient={queryClient} />
            {children}
        </QueryClientProvider>
    );
}
