"use client";

import {
    createContext,
    type ReactNode,
    useContext,
    useMemo,
    useState,
} from "react";

interface HistoryRefreshIndicatorValue {
    /** True while a treasury history refresh is in flight. */
    isRefreshing: boolean;
    setIsRefreshing: (value: boolean) => void;
}

const HistoryRefreshIndicatorContext =
    createContext<HistoryRefreshIndicatorValue | null>(null);

/**
 * Provides a shared "history refresh in progress" flag so that widgets fed by
 * the refreshed queries (balance chart, assets table, recent activity) can show
 * skeletons while the refresh button re-fetches their data.
 */
export function HistoryRefreshIndicatorProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const value = useMemo(
        () => ({ isRefreshing, setIsRefreshing }),
        [isRefreshing],
    );

    return (
        <HistoryRefreshIndicatorContext.Provider value={value}>
            {children}
        </HistoryRefreshIndicatorContext.Provider>
    );
}

/** Whether a treasury history refresh is currently in progress. */
export function useIsHistoryRefreshing(): boolean {
    return useContext(HistoryRefreshIndicatorContext)?.isRefreshing ?? false;
}

/**
 * Setter used by the refresh button to publish its in-flight state. Returns a
 * no-op when there is no provider so the button can be used standalone.
 */
export function useSetHistoryRefreshing(): (value: boolean) => void {
    const context = useContext(HistoryRefreshIndicatorContext);
    return context?.setIsRefreshing ?? noop;
}

function noop() {}
