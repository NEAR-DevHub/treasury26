"use client";

import { usePathname } from "next/navigation";
import { AppShellProvider } from "@/components/app-shell-context";
import { BalanceMaskProvider } from "@/components/balance-mask";
import { LoadingScreen } from "@/components/loading-screen";
import { MobileBottomNav } from "@/components/mobile-shell/mobile-bottom-nav";
import { MobileLanguageSheet } from "@/components/mobile-shell/mobile-language-sheet";
import { MobileMenuSheet } from "@/components/mobile-shell/mobile-menu-sheet";
import { MobileTreasurySheet } from "@/components/mobile-shell/mobile-treasury-sheet";
import { MobileUserSheet } from "@/components/mobile-shell/mobile-user-sheet";
import { PrimaryColorProvider } from "@/components/primary-color-provider";
import { Sidebar, shellSurfaceClass } from "@/components/sidebar";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { AppEventsProvider } from "./app-events-provider";

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
    // Receipt + pay share links are public/standalone (no treasury sidebar).
    const isStandaloneView =
        /\/requests\/[^/]+\/receipt$/.test(pathname ?? "") ||
        /\/pay\/(public|confidential)\/?$/.test(pathname ?? "");

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (isStandaloneView) {
        return (
            <div className="h-dvh overflow-y-auto bg-muted print:h-auto print:overflow-visible print:bg-white">
                <AppEventsProvider scope={{ treasuryId }} />
                <PrimaryColorProvider treasuryId={treasuryId} />
                {children}
            </div>
        );
    }
    return (
        <AppShellProvider>
            {/* Above the sidebar so the "hide balances" toggle on the dashboard
                also masks the treasury balances in the rail and its selector. */}
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
                        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-850 lg:rounded-3xl lg:border lg:border-gray-300 dark:lg:border-gray-700">
                            {children}
                        </div>
                        <MobileBottomNav />
                        <MobileMenuSheet />
                        <MobileUserSheet />
                        <MobileLanguageSheet />
                        <MobileTreasurySheet />
                    </main>
                </div>
            </BalanceMaskProvider>
        </AppShellProvider>
    );
}
