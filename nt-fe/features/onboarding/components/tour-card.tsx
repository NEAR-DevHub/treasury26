"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { CardComponentProps } from "nextstepjs";
import { useNextStep } from "nextstepjs";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import {
    applyDashboardTourStep,
    CREATE_TREASURY_TARGET_ID,
    closeDashboardTourSurfaces,
    DASHBOARD_TOUR_SURFACE_DELAY_MS,
    DASHBOARD_TOUR_TREASURY_STEP,
    isTourMobileViewport,
    waitForVisibleTourTarget,
} from "@/features/onboarding/dashboard-tour-targets";
import {
    refreshFeatureAnnouncements,
    suppressFeatureAnnouncements,
} from "@/features/onboarding/feature-announcement-queue";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useSidebarStore } from "@/stores/sidebar-store";
import { DASHBOARD_TOUR, TOUR_NAMES } from "../steps/dashboard";
import { EARN_ANNOUNCEMENT } from "../steps/page-tours";

// Steps that require the sidebar to be open (0-indexed) for different tours
const SIDEBAR_STEPS_MAP: Record<string, readonly number[]> = {
    [TOUR_NAMES.INFO_BOX_DISMISSED]: [0],
};

const TOUR_ACTIONS = {
    [EARN_ANNOUNCEMENT.tourName]: {
        getHref: (treasuryId?: string | null) =>
            EARN_ANNOUNCEMENT.href(treasuryId),
        ctaKey: EARN_ANNOUNCEMENT.ctaLabelKey,
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
    const isMobile = isTourMobileViewport();

    const isLastStep = currentStep === totalSteps - 1;
    const isFirstStep = currentStep === 0;
    const tourName = currentTour;
    const hidePrimaryButton = tourName === TOUR_NAMES.INFO_BOX_DISMISSED;
    const isDashboardTour = tourName === TOUR_NAMES.DASHBOARD;
    const sidebarSteps =
        SIDEBAR_STEPS_MAP[tourName as keyof typeof SIDEBAR_STEPS_MAP] || [];
    const tourAction = TOUR_ACTIONS[tourName as keyof typeof TOUR_ACTIONS];
    const showBack = isDashboardTour && totalSteps > 1 && !isFirstStep;

    const goToDashboardStep = async (stepIndex: number) => {
        applyDashboardTourStep(stepIndex, DASHBOARD_TOUR.steps[stepIndex]);
        if (stepIndex === DASHBOARD_TOUR_TREASURY_STEP) {
            await waitForVisibleTourTarget(CREATE_TREASURY_TARGET_ID);
            setCurrentStep(stepIndex);
            return;
        }
        setCurrentStep(stepIndex, DASHBOARD_TOUR_SURFACE_DELAY_MS);
    };

    const handleNext = () => {
        const nextStepIndex = currentStep + 1;

        if (isDashboardTour) {
            goToDashboardStep(nextStepIndex);
            return;
        }

        // If next step needs sidebar, open it and delay the step change
        if (sidebarSteps.includes(nextStepIndex)) {
            if (isMobile) {
                setSidebarOpen(true);
            }
            setCurrentStep(nextStepIndex, SIDEBAR_ANIMATION_DELAY);
        } else {
            nextStep();
        }
    };

    const handleBack = () => {
        if (!isDashboardTour || isFirstStep) return;
        if (currentStep === DASHBOARD_TOUR_TREASURY_STEP) {
            closeDashboardTourSurfaces();
        }
        goToDashboardStep(currentStep - 1);
    };

    const handleSkip = () => {
        if (tourName === TOUR_NAMES.INFO_BOX_DISMISSED) {
            refreshFeatureAnnouncements(2000);
        }
        if (isDashboardTour) {
            closeDashboardTourSurfaces();
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
            : isDashboardTour && isLastStep
              ? t("gotIt")
              : totalSteps === 1
                ? t("gotIt")
                : isLastStep
                  ? t("done")
                  : t("next"));

    return (
        <div
            data-onboarding-tour-card=""
            className="bg-popover-foreground text-popover rounded-md px-2 py-3 shadow-md min-w-[250px] animate-in fade-in-0 zoom-in-95"
        >
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
                        type="button"
                        onClick={handleSkip}
                        className="rounded-sm opacity-70 transition-opacity hover:opacity-100 shrink-0"
                    >
                        <Icon icon={Cancel01Icon} />
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

                        <div className="flex items-center gap-1.5">
                            {showBack && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 rounded-md px-2 text-xs text-popover hover:text-popover/90 hover:bg-transparent!"
                                    onClick={handleBack}
                                >
                                    {t("back")}
                                </Button>
                            )}
                            <Button
                                size="sm"
                                className="h-6 rounded-md px-2 text-xs bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                                onClick={handlePrimaryAction}
                            >
                                {buttonText}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
