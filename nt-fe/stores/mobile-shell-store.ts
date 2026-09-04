import { create } from "zustand";

export type MobileSheet = "treasury" | "menu" | "user" | "language" | null;

interface MobileShellStore {
    sheet: MobileSheet;
    openSheet: (sheet: MobileSheet) => void;
    closeSheet: () => void;
    /** When true, the small-screen tab bar is not rendered (review steps). */
    hideBottomNav: boolean;
    setHideBottomNav: (hide: boolean) => void;
}

export const useMobileShellStore = create<MobileShellStore>((set) => ({
    sheet: null,
    openSheet: (sheet) => set({ sheet }),
    closeSheet: () => set({ sheet: null }),
    hideBottomNav: false,
    setHideBottomNav: (hideBottomNav) => set({ hideBottomNav }),
}));
