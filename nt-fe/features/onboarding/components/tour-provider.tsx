"use client"

import { NextStepProvider, NextStep } from "nextstepjs"
import { useNextAdapter } from "nextstepjs/adapters/next"
import { TOURS } from "../steps"
import { TourCard } from "./tour-card"

export function TourProvider({ children }: { children: React.ReactNode }) {
    return (
        <NextStepProvider>
            <NextStep
                steps={TOURS}
                cardComponent={TourCard}
                navigationAdapter={useNextAdapter}
                shadowOpacity="0.5"
                noInViewScroll
            >
                {children}
            </NextStep>
        </NextStepProvider>
    )
}
