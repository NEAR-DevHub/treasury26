"use client";

import { create } from "zustand";

/**
 * Which kind of dimming layer went up. Everything counts as an overlay; side
 * sheets are counted again on their own because the phone tab bar steps aside
 * for them and for nothing else.
 */
export type OverlayKind = "modal" | "side-sheet";

type UiStore = {
    overlayCount: number;
    sideSheetCount: number;
    pushOverlay: (kind?: OverlayKind) => void;
    popOverlay: (kind?: OverlayKind) => void;
};

const sideSheetDelta = (kind: OverlayKind) => (kind === "side-sheet" ? 1 : 0);

export const useUiStore = create<UiStore>()((set) => ({
    overlayCount: 0,
    sideSheetCount: 0,
    pushOverlay: (kind = "modal") =>
        set((s) => ({
            overlayCount: s.overlayCount + 1,
            sideSheetCount: s.sideSheetCount + sideSheetDelta(kind),
        })),
    popOverlay: (kind = "modal") =>
        set((s) => ({
            overlayCount: Math.max(0, s.overlayCount - 1),
            sideSheetCount: Math.max(
                0,
                s.sideSheetCount - sideSheetDelta(kind),
            ),
        })),
}));
