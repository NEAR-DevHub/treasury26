"use client";

import { usePathname } from "next/navigation";
import { AppShellProvider } from "@/components/app-shell-context";
import { LoadingScreen } from "@/components/loading-screen";
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
            <div
                className={cn(
                    "flex h-dvh lg:h-screen overflow-hidden transition-colors duration-200",
                    shellSurfaceClass(isConfidential),
                )}
            >
                <AppEventsProvider scope={{ treasuryId }} />
                <PrimaryColorProvider treasuryId={treasuryId} />
                <Sidebar
                    isOpen={isSidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                />
                <main className="flex-1 overflow-hidden py-2 pr-2">
                    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-850 lg:rounded-3xl lg:border lg:border-gray-300 dark:lg:border-gray-700">
                        {children}
                    </div>
                </main>
            </div>
        </AppShellProvider>
    );
}
