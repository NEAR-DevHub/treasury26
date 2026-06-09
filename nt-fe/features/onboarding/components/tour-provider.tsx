"use client";

import { NextStepProvider, NextStep } from "nextstepjs";
import { useNextAdapter } from "nextstepjs/adapters/next";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useUiStore } from "@/stores/ui-store";
import { TOURS } from "../steps";
import { TourCard } from "./tour-card";

function setActiveOnboardingTour(tourName: string | null) {
    if (typeof document === "undefined") return;

    if (tourName) {
        document.body.dataset.onboardingTour = tourName;
    } else {
        delete document.body.dataset.onboardingTour;
    }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
    const setLockSelectOutside = useOnboardingStore(
        (state) => state.setLockSelectOutside,
    );
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);

    return (
        <NextStepProvider>
            <NextStep
                steps={TOURS}
                cardComponent={TourCard}
                navigationAdapter={useNextAdapter}
                shadowOpacity="0.5"
                noInViewScroll
                onStart={(tourName) => {
                    setActiveOnboardingTour(tourName);
                    setLockSelectOutside(true);
                    pushOverlay();
                }}
                onComplete={() => {
                    setActiveOnboardingTour(null);
                    setLockSelectOutside(false);
                    popOverlay();
                }}
                onSkip={() => {
                    setActiveOnboardingTour(null);
                    setLockSelectOutside(false);
                    popOverlay();
                }}
            >
                {children}
            </NextStep>
        </NextStepProvider>
    );
}
