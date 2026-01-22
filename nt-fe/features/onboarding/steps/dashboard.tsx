"use client"

import { Button } from "@/components/button"
import { useIsGuestTreasury } from "@/hooks/use-is-guest-treasury"
import { XIcon } from "lucide-react"
import { useNextStep } from "nextstepjs"
import type { Tour } from "nextstepjs"
import { useState, useEffect } from "react"

// Tour names
export const TOUR_NAMES = {
    DASHBOARD: "dashboard",
    INFO_BOX_DISMISSED: "info-box-dismissed",
} as const

// Local storage keys
export const LOCAL_STORAGE_KEYS = {
    DASHBOARD_TOUR_DISMISSED: "dashboard-tour-dismissed",
    INFO_BOX_TOUR_DISMISSED: "info-box-tour-dismissed",
} as const

// Selector IDs
export const SELECTOR_IDS = {
    DASHBOARD_STEP_1: "#dashboard-step1",
    DASHBOARD_STEP_2: "#dashboard-step2",
    DASHBOARD_STEP_3: "#dashboard-step3",
    DASHBOARD_STEP_4: "#dashboard-step4",
    DASHBOARD_STEP_5: "dashboard-step5",
    DASHBOARD_STEP_5_CREATE_TREASURY: "#dashboard-step5-create-treasury",
    HELP_SUPPORT_LINK: "#help-support-link",
} as const

export const DASHBOARD_TOUR: Tour = {
    tour: TOUR_NAMES.DASHBOARD,
    steps: [
        {
            icon: null,
            title: "",
            content: <>Add assets to your Treasury by making a deposit.</>,
            selector: SELECTOR_IDS.DASHBOARD_STEP_1,
            side: "bottom-left",
            disableInteraction: true,
            showControls: false,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <>Make payment requests whenever you need to send assets.</>,
            selector: SELECTOR_IDS.DASHBOARD_STEP_2,
            side: "bottom",
            disableInteraction: true,
            showControls: false,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <>Here you can exchange your assets.</>,
            selector: SELECTOR_IDS.DASHBOARD_STEP_3,
            side: "bottom-right",
            showControls: false,
            disableInteraction: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <>Add members to your Treasury and assign them roles.</>,
            selector: SELECTOR_IDS.DASHBOARD_STEP_4,
            side: "right",
            showControls: false,
            disableInteraction: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <>Want to set up a new Treasury? You can do it here in just a few clicks.</>,
            selector: SELECTOR_IDS.DASHBOARD_STEP_5_CREATE_TREASURY,
            side: "right",
            showControls: false,
            disableInteraction: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
    ],
}

export const INFO_BOX_TOUR: Tour = {
    tour: TOUR_NAMES.INFO_BOX_DISMISSED,
    steps: [
        {
            icon: null,
            title: "",
            content: <>Get help and support whenever you need it.</>,
            selector: SELECTOR_IDS.HELP_SUPPORT_LINK,
            side: "top",
            disableInteraction: true,
            showControls: false,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
    ],
}

export function DashboardTour() {
    const [isDismissed, setIsDismissed] = useState(true)
    const { startNextStep } = useNextStep()
    const { isGuestTreasury } = useIsGuestTreasury();

    useEffect(() => {
        if (isGuestTreasury) return;
        setIsDismissed(localStorage.getItem(LOCAL_STORAGE_KEYS.DASHBOARD_TOUR_DISMISSED) === "true")
    }, [isGuestTreasury])

    const handleDismiss = () => {
        localStorage.setItem(LOCAL_STORAGE_KEYS.DASHBOARD_TOUR_DISMISSED, "true")
        setIsDismissed(true)
    }

    const handleStartTour = () => {
        handleDismiss()
        startNextStep(TOUR_NAMES.DASHBOARD)
    }

    if (isDismissed) return null

    return (
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-popover-foreground text-popover rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">Take a quick tour of Treasury</h1>
                <XIcon className="size-4 cursor-pointer" onClick={handleDismiss} />
            </div>
            <p className="py-2 text-xs">
                See how to make a deposit, create a request, and set up a new account.
            </p>
            <div className="pt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" className="text-popover" onClick={handleDismiss}>
                    No, thanks
                </Button>
                <Button variant="default" size="sm" className="bg-popover text-popover-foreground" onClick={handleStartTour}>
                    Let's go
                </Button>
            </div>
        </div>
    )
}
