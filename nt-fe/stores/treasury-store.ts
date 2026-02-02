"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface TreasuryStore {
    lastTreasuryId: string | null;
    setLastTreasuryId: (treasuryId: string | null) => void;
}

export const useTreasuryStore = create<TreasuryStore>()(
    persist(
        (set) => ({
            lastTreasuryId: null,
            setLastTreasuryId: (treasuryId) => set({ lastTreasuryId: treasuryId }),
        }),
        {
            name: "treasury-store",
            storage: createJSONStorage(() => localStorage),
        }
    )
);
