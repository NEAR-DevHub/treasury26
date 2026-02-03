"use client"

import type { CardComponentProps } from "nextstepjs"
import { useNextStep } from "nextstepjs"
import { X } from "lucide-react"
import { Button } from "@/components/button"
import { cn } from "@/lib/utils"
import { useSidebarStore } from "@/stores/sidebar-store"
import { TOUR_NAMES, SELECTOR_IDS } from "../steps/dashboard"

// Steps that require the sidebar to be open (0-indexed) for different tours
const SIDEBAR_STEPS_MAP: Record<string, readonly number[]> = {
    [TOUR_NAMES.DASHBOARD]: [3, 4],
    [TOUR_NAMES.INFO_BOX_DISMISSED]: [0],
}

// Steps that require clicking the treasury selector (0-indexed) for different tours
const TREASURY_SELECTOR_MAP: Record<string, readonly number[]> = {
    [TOUR_NAMES.DASHBOARD]: [4],
}

export const SIDEBAR_ANIMATION_DELAY = 350

export function TourCard({
    step,
    currentStep,
    totalSteps,
    nextStep,
    skipTour,
    arrow,
}: CardComponentProps) {
    const { setCurrentStep, currentTour } = useNextStep()
    const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen)
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 1024

    const isLastStep = currentStep === totalSteps - 1
    const tourName = currentTour
    const sidebarSteps = SIDEBAR_STEPS_MAP[tourName as keyof typeof SIDEBAR_STEPS_MAP] || []
    const treasurySelectorSteps = TREASURY_SELECTOR_MAP[tourName as keyof typeof TREASURY_SELECTOR_MAP] || []

    const handleNext = () => {
        const nextStepIndex = currentStep + 1

        // If next step needs sidebar, open it and delay the step change
        if (sidebarSteps.includes(nextStepIndex)) {
            if (isMobile) {
                setSidebarOpen(true)
            }
            // If next step needs treasury selector click, handle it specially
            if (treasurySelectorSteps.includes(nextStepIndex)) {
                setTimeout(() => {
                    const trigger = document.getElementById(SELECTOR_IDS.DASHBOARD_STEP_5)
                    trigger?.click()
                    setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY)
                }, SIDEBAR_ANIMATION_DELAY + 200)
            } else {
                setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY)
            }
        } else {
            nextStep()
        }
    }

    const handleSkip = () => {
        skipTour?.()
        if (isMobile) {
            setSidebarOpen(false)
        }
    }

    const buttonText = totalSteps === 1 ? "Got It"
        : isLastStep ? "Done" : "Next"

    return (
        <div className="bg-popover-foreground text-popover rounded-md px-2 py-3 shadow-md min-w-[200px] animate-in fade-in-0 zoom-in-95">
            <div className="text-popover-foreground">
                {arrow}
            </div>

            <div className="flex flex-col gap-3">
                <div className="flex justify-between items-start gap-3">
                    <p className="text-xs">{step.content}</p>
                    <button
                        onClick={handleSkip}
                        className="rounded-sm opacity-70 transition-opacity hover:opacity-100 shrink-0"
                    >
                        <X className="h-3.5 w-3.5" />
                        <span className="sr-only">Close</span>
                    </button>
                </div>

                <div className={cn("flex w-full items-center", totalSteps > 1 ? "justify-between" : "justify-end")}>
                    {totalSteps > 1 && (
                        <p className="text-xs rounded-full text-muted-foreground">
                            {currentStep + 1} of {totalSteps}
                        </p>
                    )}

                    <Button
                        size="sm"
                        className="h-6 px-2 text-xs bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                        onClick={isLastStep ? handleSkip : handleNext}
                    >
                        {buttonText}
                    </Button>
                </div>
            </div>
        </div>
    )
}
