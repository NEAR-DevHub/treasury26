"use client";

import { Sidebar } from "@/components/sidebar";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { PrimaryColorProvider } from "@/components/primary-color-provider";

export function TreasuryLayoutClient({
  children,
  treasuryId,
}: {
  children: React.ReactNode;
  treasuryId: string;
}) {
  const { isSidebarOpen, setSidebarOpen } = useResponsiveSidebar();

  return (
    <div className="flex h-screen overflow-hidden">
      <PrimaryColorProvider treasuryId={treasuryId} />
      <Sidebar isOpen={isSidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex-1 overflow-y-auto bg-muted">
        {children}
      </main>
    </div>
  );
}
