"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { buildLoginHref } from "@/lib/auth-redirect";
import { useNear } from "@/stores/near-store";

/**
 * Blocks treasury app UI until the user is signed in. Unauthenticated visitors
 * are sent to `/login` with a safe `returnTo` so they land back on this page.
 *
 * Redirect must key off `isAuthenticated`, not `accountId`. `accountId` stays
 * null until terms are accepted (`AuthProvider` / `AcceptTermsModal`); using it
 * for redirect would bounce users who still need to accept terms.
 *
 * Render inside `AuthProvider`, which resolves the stored session first.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
    const { accountId, isAuthenticated, isInitializing } = useNear();
    const router = useRouter();
    const pathname = usePathname() ?? "/";
    const searchParams = useSearchParams();

    useEffect(() => {
        if (isInitializing || isAuthenticated) return;
        router.replace(buildLoginHref(pathname, searchParams.toString()));
    }, [isAuthenticated, isInitializing, pathname, searchParams, router]);

    if (isInitializing || !isAuthenticated) {
        return <LoadingScreen />;
    }

    // Wallet is connected but terms are still pending — keep a loading surface
    // so AuthProvider can show AcceptTermsModal without mounting treasury UI.
    if (!accountId) {
        return <LoadingScreen />;
    }

    return <>{children}</>;
}
