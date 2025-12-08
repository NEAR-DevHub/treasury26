"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Treasury = {
  name: string;
  value: string;
  balance: number;
};

type TreasuryStore = {
  selectedTreasury: string;
  setSelectedTreasury: (treasury: string) => void;
};

export const useTreasuryStore = create<TreasuryStore>()(
  persist(
    (set) => ({
      selectedTreasury: "devdao.sputnikdao.near",
      setSelectedTreasury: (treasury: string) =>
        set({ selectedTreasury: treasury }),
    }),
    {
      name: "treasury-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

// Convenience hook alias
export const useTreasury = () => {
  const selectedTreasury = useTreasuryStore((state) => state.selectedTreasury);
  const setSelectedTreasury = useTreasuryStore(
    (state) => state.setSelectedTreasury
  );
  return { selectedTreasury, setSelectedTreasury };
};
