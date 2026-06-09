"use client";

import { create } from "zustand";

type OnboardingStore = {
    lockSelectOutside: boolean;
    setLockSelectOutside: (lock: boolean) => void;
};

export const useOnboardingStore = create<OnboardingStore>()((set) => ({
    lockSelectOutside: false,
    setLockSelectOutside: (lock) => set({ lockSelectOutside: lock }),
}));
