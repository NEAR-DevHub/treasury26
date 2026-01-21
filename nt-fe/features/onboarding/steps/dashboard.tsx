import { Button } from "@/components/button";
import { XIcon } from "lucide-react";
import { StepType, useTour } from "@reactour/tour";
import { useState, useEffect } from "react";

const DASHBOARD_TOUR_DISMISSED_KEY = "dashboard-tour-dismissed";

export const DASHBOARD_TOUR: StepType[] = [
    {
        content: <>Add assets to your Treasury by making a deposit.</>,
        selector: "#dashboard-step1",
        position: "bottom",
    },
    {
        content: <>Make payment requests whenever you need to send assets.</>,
        selector: "#dashboard-step2",
        position: "bottom",
    },
    {
        content: <>Here you can exchange your assets.</>,
        selector: "#dashboard-step3",
        position: "bottom",
    },
    {
        content: <>Stake NEAR tokens to start earning.</>,
        selector: "#dashboard-step4",
        position: "bottom",
    },
    {
        content: <>Add members to your Treasury and assign them roles.</>,
        selector: "#dashboard-step5",
        position: "right",

    },
    {
        content: <>Want to set up a new Treasury? You can do it here in just a few clicks.</>,
        selector: "#dashboard-step6",
        position: "right",
        highlightedSelectors: ["#dashboard-step6-create-treasury"],
        bypassElem: true,
        mutationObservables: ["#dashboard-step6", "[data-radix-popper-content-wrapper]"],
        action: (elem) => {
            if (elem instanceof HTMLElement) {
                setTimeout(() => {
                    elem.click();
                }, 1000);
            }
        },
    }
];

export function DashboardTour() {
    const [isDismissed, setIsDismissed] = useState(true);
    const { setIsOpen } = useTour();

    useEffect(() => {
        setIsDismissed(localStorage.getItem(DASHBOARD_TOUR_DISMISSED_KEY) === "true");
    }, []);

    const handleDismiss = () => {
        localStorage.setItem(DASHBOARD_TOUR_DISMISSED_KEY, "true");
        setIsDismissed(true);
    };

    if (isDismissed) return null;

    return (
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-black text-white rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">Take a quick tour of Treasury</h1>
                <XIcon className="size-4" onClick={handleDismiss} />
            </div>
            <p className="py-2 text-xs">
                See how to make a deposit, create a request, and set up a new account.
            </p>
            <div className="pt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={handleDismiss}>
                    No, thanks
                </Button>
                <Button variant="default" size="sm" className="bg-white text-black" onClick={() => setIsOpen(true)}>
                    Let's go
                </Button>
            </div>
        </div>
    )

}
