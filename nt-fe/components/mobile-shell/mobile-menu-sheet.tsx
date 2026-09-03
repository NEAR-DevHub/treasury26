"use client";

import {
    ArrowDataTransferHorizontalIcon,
    SentIcon,
    Setting07Icon,
    UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useNextStep } from "nextstepjs";
import { Icon } from "@/components/icon";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import { TOUR_NAMES } from "@/features/onboarding/steps/dashboard";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";
import { useMobileShellStore } from "@/stores/mobile-shell-store";

export function MobileMenuSheet() {
    const t = useTranslations("nav");
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const { currentTour } = useNextStep();
    const sheet = useMobileShellStore((state) => state.sheet);
    const closeSheet = useMobileShellStore((state) => state.closeSheet);
    const isDashboardTour = currentTour === TOUR_NAMES.DASHBOARD;

    const go = (destination: string, href: string) => {
        trackEvent("nav-click", {
            destination,
            source: "mobile-menu",
            treasury_id: treasuryId,
        });
        closeSheet();
        router.push(href);
    };

    const actions = [
        {
            id: "send",
            label: t("payments"),
            icon: SentIcon,
            href: `/${treasuryId}/payments`,
            tourTargetId: "dashboard-step2-nav",
        },
        {
            id: "swap",
            label: t("exchange"),
            icon: ArrowDataTransferHorizontalIcon,
            href: `/${treasuryId}/exchange`,
            tourTargetId: "dashboard-step3-nav",
        },
        {
            id: "members",
            label: t("members"),
            icon: UserMultiple02Icon,
            href: `/${treasuryId}/members`,
            tourTargetId: "dashboard-step4",
        },
        {
            id: "settings",
            label: t("settings"),
            icon: Setting07Icon,
            href: `/${treasuryId}/settings`,
        },
    ] as const;

    return (
        <Dialog
            open={sheet === "menu"}
            modal={!isDashboardTour}
            onOpenChange={(open) => {
                if (isDashboardTour) return;
                if (!open) closeSheet();
            }}
        >
            <DialogContent>
                <SheetHandle />
                <DialogTitle className="sr-only">{t("menu")}</DialogTitle>
                <div className="grid grid-cols-2 gap-3">
                    {actions.map((action) => (
                        <button
                            key={action.id}
                            id={
                                "tourTargetId" in action
                                    ? action.tourTargetId
                                    : undefined
                            }
                            type="button"
                            onClick={() => {
                                if (isDashboardTour) return;
                                go(action.id, action.href);
                            }}
                            className="flex min-h-[92px] flex-col items-start justify-between rounded-2xl bg-gray-100 px-4 py-4 text-left font-semibold text-foreground transition-colors hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/15"
                        >
                            <Icon icon={action.icon} className="size-5" />
                            {action.label}
                        </button>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
