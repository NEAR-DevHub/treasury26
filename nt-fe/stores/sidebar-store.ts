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
      setIsMobile(window.innerWidth < 1024); // lg breakpoint
    };

    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);

    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  // Set initial state based on screen size
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false); // Mobile: starts closed, opens on button click
    } else {
      setSidebarOpen(true); // PC: starts open by default
    }
  }, [isMobile, setSidebarOpen]);

  return { isSidebarOpen, toggleSidebar, setSidebarOpen, isMobile };
};
