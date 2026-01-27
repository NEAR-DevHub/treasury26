"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useEffect, useLayoutEffect, useState } from "react";

type SidebarStore = {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
};

// Get initial state from localStorage for desktop, false for mobile
const getInitialSidebarState = () => {
  // During SSR, default to false (will be corrected after hydration)
  if (typeof window === "undefined") return false;

  try {
    // Check if we're on desktop (width >= 1024px)
    const isDesktop = window.innerWidth >= 1024;

    if (isDesktop) {
      const stored = localStorage.getItem("sidebar-open");
      return stored !== null ? JSON.parse(stored) : true; // Default to true for desktop
    }

    return false; // Always false for mobile
  } catch {
    // Fallback if localStorage or window access fails
    return false;
  }
};

// Custom storage that only persists on desktop and is SSR-safe
const desktopStorage = {
  getItem: (name: string) => {
    // During SSR, return null
    if (typeof window === "undefined") return null;

    try {
      const isDesktop = window.innerWidth >= 1024;
      return isDesktop ? localStorage.getItem(name) : null;
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string) => {
    // During SSR, do nothing
    if (typeof window === "undefined") return;

    try {
      const isDesktop = window.innerWidth >= 1024;
      if (isDesktop) {
        localStorage.setItem(name, value);
      }
    } catch {
      // Ignore errors during SSR or localStorage issues
    }
  },
  removeItem: (name: string) => {
    // During SSR, do nothing
    if (typeof window === "undefined") return;

    try {
      const isDesktop = window.innerWidth >= 1024;
      if (isDesktop) {
        localStorage.removeItem(name);
      }
    } catch {
      // Ignore errors during SSR or localStorage issues
    }
  },
};

export const useSidebarStore = create<SidebarStore>()(
  persist(
    (set) => ({
      isSidebarOpen: getInitialSidebarState(),
      toggleSidebar: () =>
        set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      setSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),
    }),
    {
      name: "sidebar-open",
      storage: createJSONStorage(() => desktopStorage),
    }
  )
);

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
  const [mounted, setMounted] = useState(false);

  // Set mounted to true after hydration
  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    // Only run on client after hydration
    if (!mounted) return;

    const checkIsMobile = () => {
      const mobile = window.innerWidth < 1024;
      const wasMobile = isMobile;
      setIsMobile(mobile);

      // Handle responsive behavior on resize
      // When switching from desktop to mobile, close sidebar (hamburger menu style)
      if (!wasMobile && mobile) {
        setSidebarOpen(false);
      }
    };

    checkIsMobile();

    window.addEventListener('resize', checkIsMobile);
    return () => window.removeEventListener('resize', checkIsMobile);
  }, [setSidebarOpen, isMobile, mounted]);

  return { isSidebarOpen, toggleSidebar, setSidebarOpen, isMobile, mounted };
};

