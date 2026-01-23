"use client";

import { Sidebar } from "@/components/sidebar";
import { useResponsiveSidebar, useSidebarStore } from "@/stores/sidebar-store";
import { PrimaryColorProvider } from "@/components/primary-color-provider";
import { useParams } from "next/navigation";

export default function TreasuryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isSidebarOpen, setSidebarOpen } = useResponsiveSidebar();
  const params = useParams();
  const treasuryId = params?.treasuryId as string | undefined;

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
