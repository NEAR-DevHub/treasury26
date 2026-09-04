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
    closeDashboardTourSurfaces,
    waitForSettledTourTarget,
} from "@/features/onboarding/dashboard-tour-targets";
import {
    refreshFeatureAnnouncements,
    suppressFeatureAnnouncements,
} from "@/features/onboarding/feature-announcement-queue";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { DASHBOARD_TOUR, TOUR_NAMES } from "../steps/dashboard";
import { EARN_ANNOUNCEMENT, PAGE_TOUR_NAMES } from "../steps/page-tours";

const TOUR_ACTIONS = {
    [EARN_ANNOUNCEMENT.tourName]: {
        getHref: (treasuryId?: string | null) =>
            EARN_ANNOUNCEMENT.href(treasuryId),
        ctaKey: EARN_ANNOUNCEMENT.ctaLabelKey,
    },
} as const;

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
    const isLastStep = currentStep === totalSteps - 1;
    const isFirstStep = currentStep === 0;
    const tourName = currentTour;
    const hidePrimaryButton =
        tourName === TOUR_NAMES.INFO_BOX_DISMISSED ||
        tourName === PAGE_TOUR_NAMES.PAYMENTS_BULK;
    const isDashboardTour = tourName === TOUR_NAMES.DASHBOARD;
    const tourAction = TOUR_ACTIONS[tourName as keyof typeof TOUR_ACTIONS];
    const showBack = isDashboardTour && totalSteps > 1 && !isFirstStep;

    const goToDashboardStep = async (stepIndex: number) => {
        const nextStepDef = DASHBOARD_TOUR.steps[stepIndex];
        applyDashboardTourStep(stepIndex, nextStepDef);
        await waitForSettledTourTarget(nextStepDef?.selector);
        setCurrentStep(stepIndex);
    };

    const handleNext = () => {
        const nextStepIndex = currentStep + 1;

        if (isDashboardTour) {
            goToDashboardStep(nextStepIndex);
            return;
        }

        nextStep();
    };

    const handleBack = () => {
        if (!isDashboardTour || isFirstStep) return;
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
