"use client";

import { create } from "zustand";

type OnboardingStore = {
    lockSelectOutside: boolean;
    setLockSelectOutside: (lock: boolean) => void;
    treasurySelectorOpen: boolean;
    setTreasurySelectorOpen: (open: boolean) => void;
};

export const useOnboardingStore = create<OnboardingStore>()((set) => ({
    lockSelectOutside: false,
    setLockSelectOutside: (lock) => set({ lockSelectOutside: lock }),
    treasurySelectorOpen: false,
    setTreasurySelectorOpen: (open) => set({ treasurySelectorOpen: open }),
}));
