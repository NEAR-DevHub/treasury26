"use client";

import { create } from "zustand";
import { useEffect, useState } from "react";

type SidebarStore = {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
};

export const useSidebarStore = create<SidebarStore>((set) => ({
  isSidebarOpen: false,
  toggleSidebar: () =>
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),
}));

const useSidebar = () => {
  const isSidebarOpen = useSidebarStore((state) => state.isSidebarOpen);
  const toggleSidebar = useSidebarStore((state) => state.toggleSidebar);
  const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen);
  return { isSidebarOpen, toggleSidebar, setSidebarOpen };
};

// Hook that provides responsive sidebar behavior
export const useResponsiveSidebar = () => {
  const { isSidebarOpen, toggleSidebar, setSidebarOpen } = useSidebar();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {

    const checkIsMobile = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      setSidebarOpen(!mobile);
    };

    checkIsMobile();

    window.addEventListener('resize', checkIsMobile);
    return () => window.removeEventListener('resize', checkIsMobile);
  }, [setSidebarOpen, setIsMobile]);

  return { isSidebarOpen, toggleSidebar, setSidebarOpen, isMobile };
};

