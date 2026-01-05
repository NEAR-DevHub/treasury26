"use client";

import { useState, useEffect } from "react";

export interface UserPreferences {
  timeFormat: "12" | "24";
  autoTimezone: boolean;
  timezone: {
    utc: string;
    value: string;
    name: string;
  } | null;
}

const PREFERENCES_STORAGE_KEY = "treasury-timezone-preferences";

const DEFAULT_PREFERENCES: UserPreferences = {
  timeFormat: "12",
  autoTimezone: true,
  timezone: null,
};

/**
 * Hook to access user timezone and time format preferences
 */
export function useUserPreferences(): UserPreferences {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    
    if (typeof window === "undefined") return;

    const loadPreferences = () => {
      try {
        const stored = localStorage.getItem(PREFERENCES_STORAGE_KEY);
        if (stored) {
          setPreferences(JSON.parse(stored));
        }
      } catch (error) {
        console.error("Failed to load user preferences:", error);
      }
    };

    loadPreferences();

    // Listen for storage changes (if user changes preferences in another tab)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === PREFERENCES_STORAGE_KEY && e.newValue) {
        try {
          setPreferences(JSON.parse(e.newValue));
        } catch (error) {
          console.error("Failed to parse preferences from storage event:", error);
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Return default preferences during SSR
  if (!isMounted) {
    return DEFAULT_PREFERENCES;
  }

  return preferences;
}

