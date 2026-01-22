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

  useEffect(() => {
    const checkIsMobile = () => {
      setSidebarOpen(window.innerWidth >= 1024);
    };

    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);
    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);


  return { isSidebarOpen, toggleSidebar, setSidebarOpen, isMobile: window.innerWidth < 1024 };
};
