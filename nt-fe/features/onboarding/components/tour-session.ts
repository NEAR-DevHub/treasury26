"use client";

import { useCallback } from "react";
import { closeDashboardTourSurfaces } from "@/features/onboarding/dashboard-tour-targets";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useUiStore } from "@/stores/ui-store";

export function setActiveOnboardingTour(tourName: string | null) {
    if (typeof document === "undefined") return;

    if (tourName) {
        document.body.dataset.onboardingTour = tourName;
    } else {
        delete document.body.dataset.onboardingTour;
    }
}

export function useTourSessionCleanup() {
    const setLockSelectOutside = useOnboardingStore(
        (state) => state.setLockSelectOutside,
    );
    const popOverlay = useUiStore((s) => s.popOverlay);

    return useCallback(() => {
        setActiveOnboardingTour(null);
        setLockSelectOutside(false);
        closeDashboardTourSurfaces();
        popOverlay();
    }, [popOverlay, setLockSelectOutside]);
}
