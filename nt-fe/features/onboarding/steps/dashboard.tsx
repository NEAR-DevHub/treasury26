"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { Tour } from "nextstepjs";
import { useNextStep } from "nextstepjs";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { features } from "@/constants/features";
import {
    DASHBOARD_TOUR_SELECTOR_RETRY,
    helpSupportTourCardOffset,
    helpSupportTourSelector,
    helpSupportTourStepSide,
    isTourMobileViewport,
    waitForSettledTourTarget,
} from "@/features/onboarding/dashboard-tour-targets";
import {
    hasSeenFeature,
    markFeatureSeen,
    refreshFeatureAnnouncements,
    useFeatureAnnouncementQueueSlot,
    useFeatureAnnouncementsUnlocked,
} from "@/features/onboarding/feature-announcement-queue";
import { useAssets } from "@/hooks/use-assets";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useProposals } from "@/hooks/use-proposals";
import { useTelegramStatuses } from "@/hooks/use-telegram";
import { useTreasury } from "@/hooks/use-treasury";
import { availableBalance } from "@/lib/balance";
import { cn } from "@/lib/utils";
import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useNear } from "@/stores/near-store";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useUiStore } from "@/stores/ui-store";

// Tour names
export const TOUR_NAMES = {
    DASHBOARD: "dashboard",
    INFO_BOX_DISMISSED: "info-box-dismissed",
} as const;

// Local storage keys
export const LOCAL_STORAGE_KEYS = {
    WELCOME_DISMISSED: "welcome-dismissed",
    DASHBOARD_TOUR_COMPLETED: "dashboard-tour-completed",
    INFO_BOX_TOUR_DISMISSED: "info-box-tour-dismissed",
} as const;

// Selector IDs
export const SELECTOR_IDS = {
    DASHBOARD_STEP_1: "#dashboard-step1",
    DASHBOARD_STEP_2: "#dashboard-step2-nav",
    DASHBOARD_STEP_3: "#dashboard-step3-nav",
    DASHBOARD_STEP_4: "#dashboard-step4",
    DASHBOARD_STEP_5_CREATE_TREASURY: "#dashboard-step5-create-treasury",
    HELP_SUPPORT_LINK: "#help-support-link",
} as const;

type TourContentKey =
    | "addAssets"
    | "makeRequests"
    | "exchangeAssets"
    | "addMembers"
    | "newTreasury";

function TourContent({ k }: { k: TourContentKey }) {
    const t = useTranslations("onboarding.tour");
    return <>{t(k)}</>;
}

function HelpSupportTourContent() {
    const t = useTranslations("onboarding.tour");
    const { isConfidential } = useTreasury();

    return (
        <>{isConfidential ? t("helpSupportConfidential") : t("helpSupport")}</>
    );
}

const dashboardStep = {
    icon: null,
    title: "",
    disableInteraction: true,
    blockKeyboardControl: true,
    showControls: false,
    showSkip: false,
    pointerPadding: 0,
    pointerRadius: 16,
} as const;

export const DASHBOARD_TOUR: Tour = {
    tour: TOUR_NAMES.DASHBOARD,
    steps: [
        {
            ...dashboardStep,
            content: <TourContent k="addAssets" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_1,
            side: "bottom",
        },
        {
            ...dashboardStep,
            ...DASHBOARD_TOUR_SELECTOR_RETRY,
            content: <TourContent k="makeRequests" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_2,
            side: "right",
        },
        {
            ...dashboardStep,
            ...DASHBOARD_TOUR_SELECTOR_RETRY,
            content: <TourContent k="exchangeAssets" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_3,
            side: "right",
        },
        {
            ...dashboardStep,
            ...DASHBOARD_TOUR_SELECTOR_RETRY,
            content: <TourContent k="addMembers" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_4,
            side: "right",
        },
        {
            ...dashboardStep,
            ...DASHBOARD_TOUR_SELECTOR_RETRY,
            content: <TourContent k="newTreasury" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_5_CREATE_TREASURY,
            // Sit above the Create row, left-aligned on the + icon, so the
            // card does not look like it belongs to Manage Treasuries.
            side: "top-left",
            cardOffset: 10,
            pointerRadius: 6,
        },
    ],
};

export const INFO_BOX_TOUR: Tour = {
    tour: TOUR_NAMES.INFO_BOX_DISMISSED,
    steps: [
        {
            icon: null,
            title: "",
            content: <HelpSupportTourContent />,
            selector: SELECTOR_IDS.HELP_SUPPORT_LINK,
            side: "right",
            disableInteraction: true,
            showControls: false,
            showSkip: false,
            pointerPadding: 0,
            pointerRadius: 16,
            ...DASHBOARD_TOUR_SELECTOR_RETRY,
        },
    ],
};

const FLOATING_TOOLTIP_CLASS =
    "fixed z-50 flex flex-col gap-0 bottom-8 p-3.5 bg-popover-foreground text-popover rounded-2xl max-w-72 right-8 max-lg:inset-x-4 max-lg:bottom-24 max-lg:max-w-none";

/** The cards sit on the inverted popover surface, so their buttons invert too. */
const tooltipPrimaryButtonClass =
    "rounded-md bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90";
const tooltipGhostButtonClass =
    "rounded-md text-popover hover:text-popover/90 hover:bg-transparent!";

/** Dims the app behind a floating tooltip for as long as it is on screen. */
function useOverlayWhileVisible(isVisible: boolean) {
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);

    useEffect(() => {
        if (!isVisible) return;
        pushOverlay();
        return popOverlay;
    }, [isVisible, popOverlay, pushOverlay]);
}

/** On small screens the cards would sit under the sidebar or an open sheet. */
function useHiddenBehindMobileChrome() {
    const isMobile = useMediaQuery("(max-width: 1023px)");
    const isSidebarOpen = useSidebarStore((state) => state.isSidebarOpen);
    const mobileSheet = useMobileShellStore((state) => state.sheet);

    return isMobile && (isSidebarOpen || !!mobileSheet);
}

/**
 * Bottom-corner card shared by the welcome, congrats and feature-announcement
 * tooltips. `progress` is the optional "1 of 2" label on the left of the
 * action row; without it the actions sit flush right.
 */
function FloatingTooltip({
    heading,
    body,
    progress,
    actions,
    onDismiss,
}: {
    heading: React.ReactNode;
    body: React.ReactNode;
    progress?: React.ReactNode;
    actions: React.ReactNode;
    onDismiss: () => void;
}) {
    const t = useTranslations("onboarding.tourCard");

    return (
        <div className={FLOATING_TOOLTIP_CLASS}>
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">{heading}</h1>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100"
                >
                    <Icon icon={Cancel01Icon} />
                    <span className="sr-only">{t("close")}</span>
                </button>
            </div>
            <p className="py-2 text-xs">{body}</p>
            <div
                className={cn(
                    "pt-2 flex items-center",
                    progress ? "justify-between" : "justify-end",
                )}
            >
                {progress}
                <div className="flex items-center gap-1.5">{actions}</div>
            </div>
        </div>
    );
}

/**
 * Starts the Help & Support spotlight after the dashboard info box is closed.
 *
 * The target is the visible profile control: the sidebar account row on large
 * screens, the header avatar on small ones. The desktop sidebar is
 * `display: none` below `lg`, so opening it on a phone would start the tour
 * overlay against a hidden node — the card never appears and the screen
 * stays blocked.
 */
export function scheduleHelpSupportTour(
    startNextStep: (tourName: string) => void,
) {
    if (typeof window === "undefined") {
        return;
    }

    const mobile = isTourMobileViewport();
    const step = INFO_BOX_TOUR.steps[0];
    if (step) {
        step.side = helpSupportTourStepSide(mobile);
        step.selector = helpSupportTourSelector(mobile);
        step.cardOffset = helpSupportTourCardOffset(mobile);
    }

    // The info box sits below the fold on phones. Bring the header avatar
    // back into view first, otherwise nextstepjs measures a scrolled
    // document Y and flips `bottom-right` to `top-right` — the card then
    // clips against the top of the screen.
    if (mobile && step?.selector) {
        document.querySelector(step.selector)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    }

    void waitForSettledTourTarget(step?.selector).then(() => {
        startNextStep(TOUR_NAMES.INFO_BOX_DISMISSED);
    });
}

export function WelcomeTooltip() {
    const tW = useTranslations("onboarding.welcome");
    const tWC = useTranslations("onboarding.welcome.confidential");
    const [isWelcomeDismissed, setIsWelcomeDismissed] = useState(true);
    const [currentStep, setCurrentStep] = useState(1);
    const { startNextStep } = useNextStep();
    const { isGuestTreasury, isLoading, isConfidential } = useTreasury();
    const { accountId } = useNear();
    const closeSheet = useMobileShellStore((state) => state.closeSheet);
    const hidden = useHiddenBehindMobileChrome();

    useEffect(() => {
        if (isGuestTreasury || isLoading) return;
        const welcomeDismissed = localStorage.getItem(
            LOCAL_STORAGE_KEYS.WELCOME_DISMISSED,
        );
        setIsWelcomeDismissed(welcomeDismissed === "true");
    }, [isGuestTreasury, isLoading]);

    useOverlayWhileVisible(!isWelcomeDismissed);

    const handleDismiss = () => {
        localStorage.setItem(LOCAL_STORAGE_KEYS.WELCOME_DISMISSED, "true");
        refreshFeatureAnnouncements(2000);
        setIsWelcomeDismissed(true);
    };

    const handleNext = () => {
        if (currentStep === 1) {
            setCurrentStep(2);
        } else {
            handleDismiss();
        }
    };

    const handleStartTour = () => {
        handleDismiss();
        closeSheet();
        // Scroll the balance card (which contains the tour targets) into view
        const balanceCard = document.getElementById("balance-with-graph");
        if (balanceCard) {
            balanceCard.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
        setTimeout(() => {
            startNextStep(TOUR_NAMES.DASHBOARD);
        }, 600);
    };

    if (
        isWelcomeDismissed ||
        isGuestTreasury ||
        isLoading ||
        hidden ||
        !accountId
    )
        return null;

    const isIntro = currentStep === 1;

    return (
        <FloatingTooltip
            heading={
                isIntro
                    ? isConfidential
                        ? tWC("heading")
                        : tW("heading")
                    : tW("subheading")
            }
            body={isIntro ? tW("body") : tW("body2")}
            progress={
                <span className="text-xs text-popover/70">
                    {tW("progress", { current: currentStep, total: 2 })}
                </span>
            }
            onDismiss={handleDismiss}
            actions={
                isIntro ? (
                    <Button
                        variant="default"
                        size="sm"
                        className={tooltipPrimaryButtonClass}
                        onClick={handleNext}
                    >
                        {tW("next")}
                    </Button>
                ) : (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={tooltipGhostButtonClass}
                            onClick={handleDismiss}
                        >
                            {tW("noThanks")}
                        </Button>
                        <Button
                            variant="default"
                            size="sm"
                            className={tooltipPrimaryButtonClass}
                            onClick={handleStartTour}
                        >
                            {tW("letsGo")}
                        </Button>
                    </>
                )
            }
        />
    );
}

export function CongratsTooltip() {
    const tC = useTranslations("onboarding.congrats");
    const [isVisible, setIsVisible] = useState(false);
    const {
        isGuestTreasury,
        isLoading: isLoadingGuestTreasury,
        treasuryId,
    } = useTreasury();
    const { accountId } = useNear();
    const { currentTour } = useNextStep();
    const isTourActive = !!currentTour;
    const hidden = useHiddenBehindMobileChrome();

    const { data, isLoading: isLoadingAssets } = useAssets(treasuryId);
    const { tokens } = data || { tokens: [] };
    const { data: proposals, isLoading: isLoadingProposals } = useProposals(
        treasuryId,
        {
            types: ["Payments"],
        },
    );

    const isLoading =
        isLoadingAssets || isLoadingProposals || isLoadingGuestTreasury;

    useOverlayWhileVisible(isVisible);

    useEffect(() => {
        if (isGuestTreasury || isLoading) return;

        // Check if welcome has been dismissed first
        const welcomeDismissed = localStorage.getItem(
            LOCAL_STORAGE_KEYS.WELCOME_DISMISSED,
        );

        if (welcomeDismissed !== "true") {
            return; // Don't show congrats if welcome is still active
        }

        const hasAssets =
            tokens.filter((token) => availableBalance(token.balance).gt(0))
                .length > 0;
        const hasPayments =
            !!proposals?.proposals?.length && proposals.proposals.length > 0;

        // All steps completed: Create Treasury (always true if user is here) + Add Assets + Create Payment
        const allStepsCompleted = hasAssets && hasPayments;

        // Check if we've already shown the congrats message
        const congratsShown = localStorage.getItem(
            LOCAL_STORAGE_KEYS.DASHBOARD_TOUR_COMPLETED,
        );

        if (allStepsCompleted && congratsShown !== "true") {
            setIsVisible(true);
        }
    }, [isGuestTreasury, isLoading, tokens, proposals]);

    const handleDismiss = () => {
        setIsVisible(false);
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.DASHBOARD_TOUR_COMPLETED,
            "true",
        );
        refreshFeatureAnnouncements(2000);
    };

    if (
        !isVisible ||
        isGuestTreasury ||
        isLoading ||
        hidden ||
        !accountId ||
        isTourActive
    )
        return null;

    return (
        <FloatingTooltip
            heading={tC("heading")}
            body={tC("body")}
            onDismiss={handleDismiss}
            actions={
                <Button
                    variant="default"
                    size="sm"
                    className={tooltipPrimaryButtonClass}
                    onClick={handleDismiss}
                >
                    {tC("letsGo")}
                </Button>
            }
        />
    );
}

export function NotificationsTooltip() {
    const tN = useTranslations("onboarding.notifications");
    const router = useRouter();
    const [isVisible, setIsVisible] = useState(false);
    const { isGuestTreasury, isLoading, treasuryId } = useTreasury();
    const { accountId } = useNear();
    const isMobile = useMediaQuery("(max-width: 768px)");
    const isSidebarOpen = useSidebarStore((state) => state.isSidebarOpen);
    const { currentTour } = useNextStep();
    const isTourActive = !!currentTour;
    const featuresUnlocked = useFeatureAnnouncementsUnlocked();

    const statusQueries = useTelegramStatuses(treasuryId ? [treasuryId] : []);
    const statusResult =
        treasuryId && statusQueries.length > 0 ? statusQueries[0] : undefined;
    const telegramConnected = Boolean(statusResult?.data?.connected);
    const isLoadingTelegram =
        !!treasuryId && !!(statusResult?.isLoading || statusResult?.isPending);

    const hidden = isMobile && isSidebarOpen;
    const hasSeenEarnFeature = hasSeenFeature("earn");
    const notificationsShown = hasSeenFeature("notifications");

    const isNotificationsFeatureEligible =
        features.integrations &&
        !isGuestTreasury &&
        !isLoading &&
        !!treasuryId &&
        !!accountId &&
        featuresUnlocked &&
        hasSeenEarnFeature &&
        !notificationsShown &&
        !isLoadingTelegram &&
        !telegramConnected;

    const notificationsQueueSlot = useFeatureAnnouncementQueueSlot({
        id: "feature-announcement-notifications",
        priority: 2,
        eligible: isNotificationsFeatureEligible,
    });

    useOverlayWhileVisible(isVisible);

    useEffect(() => {
        if (
            !isNotificationsFeatureEligible ||
            !notificationsQueueSlot.isActive
        ) {
            return;
        }

        setIsVisible(true);
    }, [isNotificationsFeatureEligible, notificationsQueueSlot.isActive]);

    useEffect(() => {
        if (telegramConnected) {
            setIsVisible(false);
        }
    }, [telegramConnected]);

    const handleDismiss = () => {
        setIsVisible(false);
        notificationsQueueSlot.release(400);
        markFeatureSeen("notifications");
    };

    const handleTryIt = () => {
        handleDismiss();
        router.push(`/${treasuryId}/settings?tab=integrations`);
    };

    if (!isVisible || hidden || isTourActive) {
        return null;
    }

    return (
        <FloatingTooltip
            heading={`🎉 ${tN("title")}`}
            body={tN("body")}
            onDismiss={handleDismiss}
            actions={
                <Button
                    variant="default"
                    size="sm"
                    className={tooltipPrimaryButtonClass}
                    onClick={handleTryIt}
                >
                    {tN("tryIt")}
                </Button>
            }
        />
    );
}
