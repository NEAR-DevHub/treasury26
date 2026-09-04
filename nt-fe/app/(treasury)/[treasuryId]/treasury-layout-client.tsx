"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect } from "react";
import { AppShellProvider } from "@/components/app-shell-context";
import { BalanceMaskProvider } from "@/components/balance-mask";
import { LoadingScreen } from "@/components/loading-screen";
import { MobileBottomNav } from "@/components/mobile-shell/mobile-bottom-nav";
import { MobileLanguageSheet } from "@/components/mobile-shell/mobile-language-sheet";
import { MobileMenuSheet } from "@/components/mobile-shell/mobile-menu-sheet";
import { MobileTreasurySheet } from "@/components/mobile-shell/mobile-treasury-sheet";
import { MobileUserSheet } from "@/components/mobile-shell/mobile-user-sheet";
import { PrimaryColorProvider } from "@/components/primary-color-provider";
import { RequireAuth } from "@/components/require-auth";
import { RequireTreasuryMember } from "@/components/require-treasury-member";
import { Sidebar, shellSurfaceClass } from "@/components/sidebar";
import { useTreasury } from "@/hooks/use-treasury";
import { trackInAppPath } from "@/lib/in-app-navigation";
import { cn } from "@/lib/utils";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { useUiStore } from "@/stores/ui-store";
import { AppEventsProvider } from "./app-events-provider";

function isPaySharePath(pathname: string | null): boolean {
    return /\/pay\/(public|confidential)\/?$/.test(pathname ?? "");
}

function isReceiptPath(pathname: string | null): boolean {
    return /\/requests\/[^/]+\/receipt$/.test(pathname ?? "");
}

/**
 * A single request opened full screen. The design gives it the whole phone
 * viewport — its own header's back control leads out of it — while the list it
 * came from keeps the tab bar, requests being a destination of its own.
 */
function isRequestDetailPath(pathname: string | null): boolean {
    return /\/requests\/[^/]+\/?$/.test(pathname ?? "");
}

export function TreasuryLayoutClient({
    children,
    treasuryId,
}: {
    children: React.ReactNode;
    treasuryId: string;
}) {
    const { isSidebarOpen, setSidebarOpen } = useResponsiveSidebar();
    const { isLoading, isConfidential } = useTreasury();
    const pathname = usePathname();
    useLayoutEffect(() => {
        if (pathname) trackInAppPath(pathname);
    }, [pathname]);
    // A side sheet rises over the whole phone viewport, so the tab bar behind
    // it steps aside for as long as it is open.
    const isSideSheetOpen = useUiStore((s) => s.sideSheetCount > 0);
    const isPayShare = isPaySharePath(pathname);
    // Standalone chrome (no sidebar): pay share + receipts. Access control is
    // separate — only pay share skips auth/membership below.
    const isStandaloneView = isPayShare || isReceiptPath(pathname);

    if (isLoading) {
        return <LoadingScreen />;
    }

    const content = isStandaloneView ? (
        <div
            className={cn(
                "h-dvh overflow-y-auto bg-general-bg-tertiary print:h-auto print:overflow-visible print:bg-white",
            )}
        >
            <AppEventsProvider scope={{ treasuryId }} />
            <PrimaryColorProvider treasuryId={treasuryId} />
            {children}
        </div>
    ) : (
        <AppShellProvider>
            <BalanceMaskProvider>
                <div
                    className={cn(
                        "flex h-dvh lg:h-screen overflow-hidden transition-colors duration-200",
                        shellSurfaceClass(isConfidential),
                    )}
                >
                    <AppEventsProvider scope={{ treasuryId }} />
                    <PrimaryColorProvider treasuryId={treasuryId} />
                    <div className="hidden lg:block">
                        <Sidebar
                            isOpen={isSidebarOpen}
                            onClose={() => setSidebarOpen(false)}
                        />
                    </div>
                    <main className="flex min-h-0 flex-1 flex-col overflow-hidden lg:py-2 lg:pr-2">
                        <div className="min-h-0 flex-1 overflow-y-auto bg-general-bg-tertiary lg:rounded-3xl lg:border lg:border-gray-300 dark:lg:border-gray-700">
                            {children}
                        </div>
                        {!isRequestDetailPath(pathname) && !isSideSheetOpen && (
                            <MobileBottomNav />
                        )}
                        <MobileMenuSheet />
                        <MobileUserSheet />
                        <MobileLanguageSheet />
                        <MobileTreasurySheet />
                    </main>
                </div>
            </BalanceMaskProvider>
        </AppShellProvider>
    );

    // Pay share (`/pay/public|confidential`) is the only public treasury route.
    // Receipts and every other path require sign-in + membership; receipts only
    // differ by using the sidebar-less standalone chrome above.
    if (isPayShare) {
        return content;
    }

    return (
        <RequireAuth>
            <RequireTreasuryMember>{content}</RequireTreasuryMember>
        </RequireAuth>
    );
}
