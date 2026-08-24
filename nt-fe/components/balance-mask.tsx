"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
    useState,
} from "react";

/** Dots shown in place of a balance while masking is on. */
export const BALANCE_MASK = "••••••";

interface BalanceMaskValue {
    isMasked: boolean;
    toggle: () => void;
}

const BalanceMaskContext = createContext<BalanceMaskValue | null>(null);

/**
 * Shares the "hide balances" flag toggled next to the dashboard total balance,
 * so every amount on the page (total, assets table, recent activity) is masked
 * together. Widgets rendered outside a provider are never masked.
 */
export function BalanceMaskProvider({ children }: { children: ReactNode }) {
    const [isMasked, setIsMasked] = useState(false);
    const toggle = useCallback(() => setIsMasked((v) => !v), []);
    const value = useMemo(() => ({ isMasked, toggle }), [isMasked, toggle]);

    return (
        <BalanceMaskContext.Provider value={value}>
            {children}
        </BalanceMaskContext.Provider>
    );
}

/** Whether balances should currently be replaced with dots. */
export function useIsBalanceMasked(): boolean {
    return useContext(BalanceMaskContext)?.isMasked ?? false;
}

/** State plus setter for the eye toggle that drives the mask. */
export function useBalanceMask(): BalanceMaskValue {
    const context = useContext(BalanceMaskContext);
    if (!context) {
        throw new Error(
            "useBalanceMask must be used within BalanceMaskProvider",
        );
    }
    return context;
}

/** Renders dots instead of its children while balances are masked. */
export function MaskedBalance({ children }: { children: ReactNode }) {
    return <>{useIsBalanceMasked() ? BALANCE_MASK : children}</>;
}
