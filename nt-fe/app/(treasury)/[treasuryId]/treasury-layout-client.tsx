"use client";

import { usePathname } from "next/navigation";
import { AppShellProvider } from "@/components/app-shell-context";
import { LoadingScreen } from "@/components/loading-screen";
import { PrimaryColorProvider } from "@/components/primary-color-provider";
import { Sidebar } from "@/components/sidebar";
import { useTreasury } from "@/hooks/use-treasury";
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
    const { isLoading } = useTreasury();
    const pathname = usePathname();
    const isStandaloneReceiptView = /\/requests\/[^/]+\/receipt$/.test(
        pathname ?? "",
    );

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (isStandaloneReceiptView) {
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
            <div className="flex h-dvh lg:h-screen overflow-hidden bg-gray-850 transition-colors duration-200">
                <AppEventsProvider scope={{ treasuryId }} />
                <PrimaryColorProvider treasuryId={treasuryId} />
                <Sidebar
                    isOpen={isSidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                />
                <main className="flex-1 overflow-hidden lg:p-2">
                    <div className="h-full overflow-y-auto bg-background lg:rounded-3xl">
                        {children}
                    </div>
                </main>
            </div>
        </AppShellProvider>
    );
}
