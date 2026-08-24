import { create } from "zustand";

export type MobileSheet = "treasury" | "menu" | "user" | "language" | null;

interface MobileShellStore {
    sheet: MobileSheet;
    openSheet: (sheet: MobileSheet) => void;
    closeSheet: () => void;
}

export const useMobileShellStore = create<MobileShellStore>((set) => ({
    sheet: null,
    openSheet: (sheet) => set({ sheet }),
    closeSheet: () => set({ sheet: null }),
}));
