"use client";

import { Sidebar } from "@/components/sidebar";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { PrimaryColorProvider } from "@/components/primary-color-provider";
import { LoadingScreen } from "@/components/loading-screen";
import { useTreasury } from "@/hooks/use-treasury";

export function TreasuryLayoutClient({
    children,
    treasuryId,
}: {
    children: React.ReactNode;
    treasuryId: string;
}) {
    const { isSidebarOpen, setSidebarOpen } = useResponsiveSidebar();
    const { isLoading } = useTreasury();

    if (isLoading) {
        return <LoadingScreen />;
    }

    return (
        <div className="flex h-dvh lg:h-screen overflow-hidden">
            <PrimaryColorProvider treasuryId={treasuryId} />
            <Sidebar
                isOpen={isSidebarOpen}
                onClose={() => setSidebarOpen(false)}
            />
            <main className="flex-1 overflow-y-auto bg-muted">{children}</main>
        </div>
    );
}
