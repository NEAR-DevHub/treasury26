"use client";

import { useLayoutEffect } from "react";
import { useMobileShellStore } from "@/stores/mobile-shell-store";

/** Hides the small-screen tab bar for the lifetime of the calling component. */
export function useHideMobileBottomNav() {
    const setHideBottomNav = useMobileShellStore(
        (state) => state.setHideBottomNav,
    );

    useLayoutEffect(() => {
        setHideBottomNav(true);
        return () => setHideBottomNav(false);
    }, [setHideBottomNav]);
}
