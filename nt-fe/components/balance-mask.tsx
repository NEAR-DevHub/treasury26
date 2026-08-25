"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

/** Dots shown in place of a balance while masking is on. */
export const BALANCE_MASK = "••••••";

const STORAGE_KEY = "balance-mask";

/** Anything other than an explicit "on" means balances stay visible. */
function readStoredMask(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
        // Storage can be unavailable (private mode, blocked cookies) — show balances.
        return false;
    }
}

function writeStoredMask(isMasked: boolean) {
    try {
        localStorage.setItem(STORAGE_KEY, String(isMasked));
    } catch {
        // Preference just won't survive the reload.
    }
}

interface BalanceMaskValue {
    isMasked: boolean;
    toggle: () => void;
}

const BalanceMaskContext = createContext<BalanceMaskValue | null>(null);

/**
 * Shares the "hide balances" flag toggled next to the dashboard total balance.
 * Mounted around the whole treasury shell, so every amount masks together: the
 * page (total, assets table, recent activity), the sidebar treasury balances and
 * request amounts. The choice is remembered in local storage; widgets rendered
 * outside a provider are never masked.
 */
export function BalanceMaskProvider({ children }: { children: ReactNode }) {
    // Starts visible so the server render matches; the stored preference is
    // applied on mount, which still lands before any balance query resolves.
    const [isMasked, setIsMasked] = useState(false);

    useEffect(() => {
        setIsMasked(readStoredMask());
    }, []);

    const toggle = useCallback(() => {
        const next = !isMasked;
        setIsMasked(next);
        writeStoredMask(next);
    }, [isMasked]);

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
