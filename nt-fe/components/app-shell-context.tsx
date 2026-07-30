"use client";

import { createContext, useContext } from "react";

/**
 * True when the page is rendered inside the treasury shell (i.e. the dark
 * sidebar rail is present). Header chrome that lives in the rail's profile menu
 * — wallet connect, language, theme — is suppressed in the page header there,
 * but still has to render on sidebar-less pages (login, create, stats, …).
 */
const AppShellContext = createContext(false);

export function AppShellProvider({ children }: { children: React.ReactNode }) {
    return (
        <AppShellContext.Provider value={true}>
            {children}
        </AppShellContext.Provider>
    );
}

export function useHasSidebarRail() {
    return useContext(AppShellContext);
}
