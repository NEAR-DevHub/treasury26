import { Button } from "@/components/button";
import { XIcon } from "lucide-react";
import { useOnborda } from "onborda";
import { Tour } from "onborda/dist/types";

export const DASHBOARD_TOUR: Tour = {
    tour: "dashboard",
    steps: [
        {
            icon: null,
            title: "",
            content: <>Add assets to your Treasury by making a deposit.</>,
            selector: "#dashboard-step1",
            side: "bottom",
            showControls: true,
            pointerPadding: 15,
        },
        {
            icon: null,
            title: "",
            content: <>Make payment requests whenever you need to send assets.</>,
            selector: "#dashboard-step2",
            side: "bottom",
            showControls: true,
            pointerPadding: 15,
        },
        {
            icon: null,
            title: "",
            content: <>Here you can exchange your assets.</>,
            selector: "#dashboard-step3",
            side: "bottom",
            showControls: true,
            pointerPadding: 15,
        },
        {
            icon: null,
            title: "",
            content: <>Stake NEAR tokens to start earning.</>,
            selector: "#dashboard-step4",
            side: "bottom",
            showControls: true,
            pointerPadding: 15,
        },
        {
            icon: null,
            title: "",
            content: <>Add members to your Treasury and assign them roles.</>,
            selector: "#dashboard-step5",
            side: "right",
            showControls: true,
            pointerPadding: 5,
        },
        {
            icon: null,
            title: "",
            content: <>Want to set up a new Treasury? You can do it here in just a few clicks.</>,
            selector: "#dashboard-step6",
            side: "right",
            showControls: true,
        }
    ]
};

export function DashboardTour() {
    const { startOnborda, closeOnborda } = useOnborda();

    return (
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-black text-white rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">Take a quick tour of Treasury</h1>
                <XIcon className="size-4" onClick={closeOnborda} />
            </div>
            <p className="py-2 text-xs">
                See how to make a deposit, create a request, and set up a new account.
            </p>
            <div className="pt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={closeOnborda}>
                    No, thanks
                </Button>
                <Button variant="default" size="sm" className="bg-white text-black" onClick={() => startOnborda("dashboard")}>
                    Let's go
                </Button>
            </div>
        </div>
    )

}
