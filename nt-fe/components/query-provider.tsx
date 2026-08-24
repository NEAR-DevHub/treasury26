"use client";

import * as Sentry from "@sentry/nextjs";
import {
    MutationCache,
    QueryCache,
    QueryClient,
    QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { isReportedError, markReportedError } from "@/lib/http";
import { clearSessionQueries } from "@/lib/session-query-cleanup";
import { isUserRejection } from "@/lib/wallet-errors";
import { useNearStore } from "@/stores/near-store";

/**
 * Last-resort capture for query/mutation failures nothing else reported:
 * the shared http interceptor already covers backend 5xx/network errors
 * (skipped via isReportedError), and wallet rejections are expected user
 * outcomes. Everything else was previously swallowed silently by React Query.
 */
function reportUnhandled(
    error: unknown,
    errorCode: "FE_QUERY_FAILED" | "FE_MUTATION_FAILED",
    key: string,
) {
    if (isReportedError(error) || isUserRejection(error)) {
        return;
    }
    markReportedError(error);
    Sentry.withScope((scope) => {
        scope.setTag("error_code", errorCode);
        scope.setTag("priority", "p2");
        scope.setTag("operation", key);
        scope.setFingerprint([errorCode, key]);
        Sentry.captureException(error);
    });
}

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
                queryCache: new QueryCache({
                    onError: (error, query) =>
                        reportUnhandled(
                            error,
                            "FE_QUERY_FAILED",
                            String(query.queryKey[0] ?? "unknown"),
                        ),
                }),
                mutationCache: new MutationCache({
                    onError: (error, _variables, _context, mutation) =>
                        reportUnhandled(
                            error,
                            "FE_MUTATION_FAILED",
                            String(
                                mutation.options.mutationKey?.[0] ?? "unknown",
                            ),
                        ),
                }),
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
