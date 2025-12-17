"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Treasury = {
  daoId: string;
  name: string;
  flagLogo: string;
};

type TreasuryStore = {
  selectedTreasury: Treasury | null;
  setSelectedTreasury: (treasury: Treasury) => void;
};

export const useTreasuryStore = create<TreasuryStore>()(
  persist(
    (set) => ({
      selectedTreasury: null,
      setSelectedTreasury: (treasury: Treasury) =>
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
  return { selectedTreasury: selectedTreasury?.daoId, treasury: selectedTreasury, setSelectedTreasury };
};
