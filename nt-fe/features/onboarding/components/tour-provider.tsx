"use client";

import { NextStep, NextStepProvider } from "nextstepjs";
import { useNextAdapter } from "nextstepjs/adapters/next";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useUiStore } from "@/stores/ui-store";
import { TOURS } from "../steps";
import { TOUR_NAMES } from "../steps/dashboard";
import { TourCard } from "./tour-card";
import { TourSafetyNet } from "./tour-safety-net";
import { setActiveOnboardingTour, useTourSessionCleanup } from "./tour-session";

function TourSession({ children }: { children: React.ReactNode }) {
    const cleanup = useTourSessionCleanup();
    const setLockSelectOutside = useOnboardingStore(
        (state) => state.setLockSelectOutside,
    );
    const pushOverlay = useUiStore((s) => s.pushOverlay);

    return (
        <NextStep
            steps={TOURS}
            cardComponent={TourCard}
            navigationAdapter={useNextAdapter}
            shadowOpacity="0.5"
            noInViewScroll
            onStart={(tourName) => {
                setActiveOnboardingTour(tourName);
                // Only the dashboard tour steps into the treasury selector, so
                // only it needs the selector held open against outside clicks.
                setLockSelectOutside(tourName === TOUR_NAMES.DASHBOARD);
                pushOverlay();
            }}
            onComplete={cleanup}
            onSkip={cleanup}
        >
            <TourSafetyNet />
            {children}
        </NextStep>
    );
}

export function TourProvider({ children }: { children: React.ReactNode }) {
    return (
        <NextStepProvider>
            <TourSession>{children}</TourSession>
        </NextStepProvider>
    );
}
