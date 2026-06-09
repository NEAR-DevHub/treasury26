"use client";

import type { CardComponentProps } from "nextstepjs";
import { useNextStep } from "nextstepjs";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useSidebarStore } from "@/stores/sidebar-store";
import {
    refreshFeatureAnnouncements,
    suppressFeatureAnnouncements,
} from "@/features/onboarding/feature-announcement-queue";
import { TOUR_NAMES, SELECTOR_IDS } from "../steps/dashboard";
import {
    EARN_ANNOUNCEMENT,
    PAYMENTS_BULK_ANNOUNCEMENT,
    PAYMENTS_PENDING_ANNOUNCEMENT,
} from "../steps/page-tours";

// Steps that require the sidebar to be open (0-indexed) for different tours
const SIDEBAR_STEPS_MAP: Record<string, readonly number[]> = {
    [TOUR_NAMES.DASHBOARD]: [3, 4],
    [TOUR_NAMES.INFO_BOX_DISMISSED]: [0],
};

// Steps that require clicking the treasury selector (0-indexed) for different tours
const TREASURY_SELECTOR_MAP: Record<string, readonly number[]> = {
    [TOUR_NAMES.DASHBOARD]: [4],
};

const TOUR_ACTIONS = {
    [EARN_ANNOUNCEMENT.tourName]: {
        getHref: (treasuryId?: string | null) =>
            EARN_ANNOUNCEMENT.href(treasuryId),
        ctaKey: EARN_ANNOUNCEMENT.ctaLabelKey,
    },
    [PAYMENTS_BULK_ANNOUNCEMENT.tourName]: {
        getHref: (treasuryId?: string | null) =>
            PAYMENTS_BULK_ANNOUNCEMENT.href(treasuryId),
        ctaKey: PAYMENTS_BULK_ANNOUNCEMENT.ctaLabelKey,
    },
    [PAYMENTS_PENDING_ANNOUNCEMENT.tourName]: {
        getHref: (treasuryId?: string | null) =>
            PAYMENTS_PENDING_ANNOUNCEMENT.href(treasuryId),
        ctaKey: PAYMENTS_PENDING_ANNOUNCEMENT.ctaLabelKey,
    },
} as const;

export const SIDEBAR_ANIMATION_DELAY = 350;

export function TourCard({
    step,
    currentStep,
    totalSteps,
    nextStep,
    skipTour,
    arrow,
}: CardComponentProps) {
    const t = useTranslations("onboarding.tourCard");
    const tTours = useTranslations("pageTours");
    const { setCurrentStep, currentTour } = useNextStep();
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen);
    const isMobile = typeof window !== "undefined" && window.innerWidth < 1024;

    const isLastStep = currentStep === totalSteps - 1;
    const tourName = currentTour;
    const hidePrimaryButton = tourName === TOUR_NAMES.INFO_BOX_DISMISSED;
    const sidebarSteps =
        SIDEBAR_STEPS_MAP[tourName as keyof typeof SIDEBAR_STEPS_MAP] || [];
    const treasurySelectorSteps =
        TREASURY_SELECTOR_MAP[tourName as keyof typeof TREASURY_SELECTOR_MAP] ||
        [];
    const tourAction = TOUR_ACTIONS[tourName as keyof typeof TOUR_ACTIONS];

    const handleNext = () => {
        const nextStepIndex = currentStep + 1;

        // If next step needs sidebar, open it and delay the step change
        if (sidebarSteps.includes(nextStepIndex)) {
            if (isMobile) {
                setSidebarOpen(true);
            }
            // If next step needs treasury selector click, handle it specially
            if (treasurySelectorSteps.includes(nextStepIndex)) {
                setTimeout(() => {
                    const trigger = document.getElementById(
                        SELECTOR_IDS.DASHBOARD_STEP_5,
                    );
                    trigger?.click();
                    setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY);
                }, SIDEBAR_ANIMATION_DELAY + 200);
            } else {
                setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY);
            }
        } else {
            nextStep();
        }
    };

    const handleSkip = () => {
        if (tourName === TOUR_NAMES.INFO_BOX_DISMISSED) {
            refreshFeatureAnnouncements(2000);
        }
        skipTour?.();
        if (isMobile) {
            setSidebarOpen(false);
        }
    };

    const handlePrimaryAction = () => {
        if (isLastStep && tourAction) {
            suppressFeatureAnnouncements(2000);
            handleSkip();
            router.push(tourAction.getHref(treasuryId));
            return;
        }

        if (isLastStep) {
            if (tourName === TOUR_NAMES.DASHBOARD) {
                skipTour?.();
                if (isMobile) {
                    setSidebarOpen(false);
                }
                return;
            }
            handleSkip();
            return;
        }

        handleNext();
    };

    const tourCtaLabel =
        isLastStep && tourAction && "ctaKey" in tourAction
            ? tTours(tourAction.ctaKey)
            : null;
    const buttonText =
        tourCtaLabel ??
        (isLastStep && step.title
            ? step.title
            : totalSteps === 1
              ? t("gotIt")
              : isLastStep
                ? t("done")
                : t("next"));

    return (
        <div className="bg-popover-foreground text-popover rounded-md px-2 py-3 shadow-md min-w-[250px] animate-in fade-in-0 zoom-in-95">
            <div className="text-popover-foreground">{arrow}</div>

            <div
                className={cn(
                    "flex flex-col",
                    hidePrimaryButton ? "gap-0" : "gap-3",
                )}
            >
                <div className="flex justify-between items-start gap-3">
                    <p className="text-xs">{step.content}</p>
                    <button
                        onClick={handleSkip}
                        className="rounded-sm opacity-70 transition-opacity hover:opacity-100 shrink-0"
                    >
                        <X className="h-3.5 w-3.5" />
                        <span className="sr-only">{t("close")}</span>
                    </button>
                </div>

                {!hidePrimaryButton && (
                    <div
                        className={cn(
                            "flex w-full items-center",
                            totalSteps > 1 ? "justify-between" : "justify-end",
                        )}
                    >
                        {totalSteps > 1 && (
                            <p className="text-xs rounded-full text-muted-foreground">
                                {t("stepProgress", {
                                    current: currentStep + 1,
                                    total: totalSteps,
                                })}
                            </p>
                        )}

                        <Button
                            size="sm"
                            className="h-6 px-2 text-xs bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                            onClick={handlePrimaryAction}
                        >
                            {buttonText}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
