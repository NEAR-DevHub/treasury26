import { useState, useEffect } from "react";

const RECENT_ADDRESSES_KEY = "recent_filter_addresses";
const MAX_RECENT_ADDRESSES = 10;

// Helper functions for localStorage
function getRecentAddresses(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const stored = localStorage.getItem(RECENT_ADDRESSES_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function saveRecentAddress(address: string) {
    if (typeof window === "undefined") return;
    try {
        const recent = getRecentAddresses();
        // Remove if already exists, then add to front
        const updated = [address, ...recent.filter(a => a !== address)].slice(0, MAX_RECENT_ADDRESSES);
        localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(updated));
    } catch {
        // Ignore localStorage errors
    }
}

/**
 * Hook to manage recently typed addresses in filters
 * Persists addresses to localStorage and provides methods to add new ones
 */
export function useRecentAddresses() {
    const [recentAddresses, setRecentAddresses] = useState<string[]>([]);

    // Load recent addresses on mount
    useEffect(() => {
        setRecentAddresses(getRecentAddresses());
    }, []);

    const addRecentAddress = (address: string) => {
        saveRecentAddress(address);
        setRecentAddresses(getRecentAddresses());
    };

    return { recentAddresses, addRecentAddress };
}
