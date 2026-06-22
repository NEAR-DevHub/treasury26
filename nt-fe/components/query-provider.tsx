"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import { clearSessionQueries } from "@/lib/session-query-cleanup";
import { useNearStore } from "@/stores/near-store";

function hasAuthenticatedSession(
    state: ReturnType<typeof useNearStore.getState>,
) {
    return (
        state.isAuthenticated &&
        state.hasAcceptedTerms &&
        !!state.walletAccountId
    );
}

function SessionQueryCleanup({ queryClient }: { queryClient: QueryClient }) {
    useEffect(() => {
        let hadAuthenticatedSession = hasAuthenticatedSession(
            useNearStore.getState(),
        );

        return useNearStore.subscribe((state) => {
            const hasSession = hasAuthenticatedSession(state);
            if (hadAuthenticatedSession && !hasSession) {
                void clearSessionQueries(queryClient);
            }
            hadAuthenticatedSession = hasSession;
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
