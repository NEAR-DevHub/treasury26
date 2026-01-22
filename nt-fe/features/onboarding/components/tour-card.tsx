"use client"

import type { CardComponentProps } from "nextstepjs"
import { useNextStep } from "nextstepjs"
import { X } from "lucide-react"
import { Button } from "@/components/button"
import { cn } from "@/lib/utils"
import { useSidebarStore } from "@/stores/sidebar-store"

// Steps that require the sidebar to be open (0-indexed)
const SIDEBAR_STEPS = [3, 4]
const SIDEBAR_ANIMATION_DELAY = 350

export function TourCard({
    step,
    currentStep,
    totalSteps,
    nextStep,
    prevStep,
    skipTour,
    arrow,
}: CardComponentProps) {
    const { setCurrentStep } = useNextStep()
    const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen)

    const isLastStep = currentStep === totalSteps - 1

    const handleNext = () => {
        const nextStepIndex = currentStep + 1

        // If next step needs sidebar, open it and delay the step change
        if (SIDEBAR_STEPS.includes(nextStepIndex)) {
            setSidebarOpen(true)

            // For step 5 (index 4), click the treasury selector to open dropdown
            if (nextStepIndex === 4) {
                setTimeout(() => {
                    const trigger = document.getElementById("dashboard-step5")
                    trigger?.click()
                    setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY)
                }, SIDEBAR_ANIMATION_DELAY + 100)
            } else {
                setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY)
            }

        } else {
            setSidebarOpen(false)
            nextStep()
        }
    }

    const handleSkip = () => {
        setSidebarOpen(false)
        skipTour?.()
    }

    return (
        <div className="relative bg-popover-foreground text-popover rounded-md px-4 py-3 shadow-md min-w-[200px] animate-in fade-in-0 zoom-in-95">
            <div className="text-popover-foreground">
                {arrow}
            </div>

            <button
                onClick={handleSkip}
                className="absolute right-2 top-2 rounded-sm opacity-70 transition-opacity hover:opacity-100"
            >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">Close</span>
            </button>

            <div className="flex w-full flex-col gap-3 pr-4">
                <p className="text-xs">{step.content}</p>

                <div className="flex w-full items-center justify-between">
                    <p className={cn("text-xs rounded-full text-muted-foreground")}>
                        {currentStep + 1} of {totalSteps}
                    </p>

                    <div className="flex gap-1">
                        <Button
                            size="sm"
                            className="h-6 px-2 text-xs bg-popover text-popover-foreground"
                            onClick={isLastStep ? handleSkip : handleNext}
                        >
                            {isLastStep ? "Done" : "Next"}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}
