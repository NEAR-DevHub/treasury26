"use client"

import { Button } from "@/components/button"
import { useIsGuestTreasury } from "@/hooks/use-is-guest-treasury"
import { XIcon } from "lucide-react"
import { useNextStep } from "nextstepjs"
import type { Tour } from "nextstepjs"
import { useState, useEffect } from "react"

const DASHBOARD_TOUR_DISMISSED_KEY = "dashboard-tour-dismissed"

export const DASHBOARD_TOUR: Tour = {
    tour: "dashboard",
    steps: [
        {
            icon: null,
            title: "",
            content: <>Add assets to your Treasury by making a deposit.</>,
            selector: "#dashboard-step1",
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
            content: <>Make payment requests whenever you need to send assets.</>,
            selector: "#dashboard-step2",
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
            selector: "#dashboard-step3",
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
            selector: "#dashboard-step4",
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
            selector: "#dashboard-step5-create-treasury",
            side: "right",
            showControls: false,
            disableInteraction: true,
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
        setIsDismissed(localStorage.getItem(DASHBOARD_TOUR_DISMISSED_KEY) === "false")
    }, [isGuestTreasury])

    const handleDismiss = () => {
        localStorage.setItem(DASHBOARD_TOUR_DISMISSED_KEY, "true")
        setIsDismissed(true)
    }

    const handleStartTour = () => {
        handleDismiss()
        startNextStep("dashboard")
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
