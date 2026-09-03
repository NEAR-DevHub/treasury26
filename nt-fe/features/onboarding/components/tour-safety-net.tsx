"use client";

import { useNextStep } from "nextstepjs";
import { useCallback, useEffect } from "react";
import { useTourSessionCleanup } from "./tour-session";

/**
 * Escape always dismisses an active tour. Dashboard steps block nextstepjs
 * keyboard handling, so without this the overlay can trap the user.
 */
export function TourSafetyNet() {
    const { isNextStepVisible, closeNextStep } = useNextStep();
    const cleanup = useTourSessionCleanup();

    const dismiss = useCallback(() => {
        cleanup();
        closeNextStep();
    }, [cleanup, closeNextStep]);

    useEffect(() => {
        if (!isNextStepVisible) return;

        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            dismiss();
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [dismiss, isNextStepVisible]);

    return null;
}
