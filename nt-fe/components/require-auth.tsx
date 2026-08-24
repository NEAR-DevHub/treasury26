"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { useNear } from "@/stores/near-store";

/**
 * Gates a route behind a connected wallet: visitors without a session are sent
 * to `/login` with a `returnTo` pointing back at the page they asked for, so
 * they land on it once the wallet is connected.
 *
 * Render inside `AuthProvider`, which resolves the stored session first — on
 * its own this only knows about the wallet connector's init.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { isInitializing, isAuthenticated } = useNear();

    const shouldRedirect = !isInitializing && !isAuthenticated;

    useEffect(() => {
        if (!shouldRedirect) return;
        const query = searchParams.toString();
        const returnTo = query ? `${pathname}?${query}` : pathname;
        router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }, [pathname, router, searchParams, shouldRedirect]);

    if (isInitializing || shouldRedirect) {
        return <LoadingScreen />;
    }

    return <>{children}</>;
}
