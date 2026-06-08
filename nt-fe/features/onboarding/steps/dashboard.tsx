"use client";

import { Button } from "@/components/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useSidebarStore } from "@/stores/sidebar-store";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useNextStep } from "nextstepjs";
import type { Tour } from "nextstepjs";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useAssets } from "@/hooks/use-assets";
import { useProposals } from "@/hooks/use-proposals";
import { useTelegramStatuses } from "@/hooks/use-telegram";
import { availableBalance } from "@/lib/balance";
import { useUiStore } from "@/stores/ui-store";
import { features } from "@/constants/features";
import {
    hasSeenFeature,
    markFeatureSeen,
    refreshFeatureAnnouncements,
    useFeatureAnnouncementQueueSlot,
    useFeatureAnnouncementsUnlocked,
} from "@/features/onboarding/feature-announcement-queue";

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
    DASHBOARD_STEP_2: "#dashboard-step2",
    DASHBOARD_STEP_3: "#dashboard-step3",
    DASHBOARD_STEP_4: "#dashboard-step4",
    DASHBOARD_STEP_5: "dashboard-step5",
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

export const DASHBOARD_TOUR: Tour = {
    tour: TOUR_NAMES.DASHBOARD,
    steps: [
        {
            icon: null,
            title: "",
            content: <TourContent k="addAssets" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_1,
            side: "bottom-left",
            disableInteraction: true,
            blockKeyboardControl: true,
            showControls: false,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <TourContent k="makeRequests" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_2,
            side: "bottom",
            disableInteraction: true,
            showControls: false,
            blockKeyboardControl: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <TourContent k="exchangeAssets" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_3,
            side: "bottom-right",
            showControls: false,
            disableInteraction: true,
            blockKeyboardControl: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <TourContent k="addMembers" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_4,
            side: "right",
            showControls: false,
            disableInteraction: true,
            blockKeyboardControl: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
        },
        {
            icon: null,
            title: "",
            content: <TourContent k="newTreasury" />,
            selector: SELECTOR_IDS.DASHBOARD_STEP_5_CREATE_TREASURY,
            side: "right",
            showControls: false,
            disableInteraction: true,
            blockKeyboardControl: true,
            showSkip: false,
            pointerPadding: 8,
            pointerRadius: 8,
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
            pointerPadding: 8,
            pointerRadius: 8,
        },
    ],
};

const HELP_SUPPORT_TOUR_SIDEBAR_DELAY_MS = 350;

export function scheduleHelpSupportTour(
    startNextStep: (tourName: string) => void,
    setSidebarOpen: (open: boolean) => void,
) {
    if (typeof window === "undefined") {
        return;
    }

    const isMobile = window.innerWidth < 1024;
    const start = () => startNextStep(TOUR_NAMES.INFO_BOX_DISMISSED);

    if (isMobile) {
        setSidebarOpen(true);
        setTimeout(start, HELP_SUPPORT_TOUR_SIDEBAR_DELAY_MS + 100);
    } else {
        setTimeout(start, 300);
    }
}

export function WelcomeTooltip() {
    const tW = useTranslations("onboarding.welcome");
    const tWC = useTranslations("onboarding.welcome.confidential");
    const [isWelcomeDismissed, setIsWelcomeDismissed] = useState(true);
    const [currentStep, setCurrentStep] = useState(1);
    const { startNextStep } = useNextStep();
    const { isGuestTreasury, isLoading, isConfidential } = useTreasury();
    const { accountId } = useNear();
    const isMobile = useMediaQuery("(max-width: 768px)");
    const isSidebarOpen = useSidebarStore((state) => state.isSidebarOpen);
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);

    const hidden = isMobile && isSidebarOpen;

    useEffect(() => {
        if (isGuestTreasury || isLoading) return;
        const welcomeDismissed = localStorage.getItem(
            LOCAL_STORAGE_KEYS.WELCOME_DISMISSED,
        );
        setIsWelcomeDismissed(welcomeDismissed === "true");
    }, [isGuestTreasury, isLoading]);

    useEffect(() => {
        if (!isWelcomeDismissed) {
            pushOverlay();
            return () => popOverlay();
        }
    }, [isWelcomeDismissed]);

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

    return (
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-popover-foreground text-popover rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">
                    {currentStep === 1
                        ? isConfidential
                            ? tWC("heading")
                            : tW("heading")
                        : tW("subheading")}
                </h1>
                <XIcon
                    className="size-4 cursor-pointer"
                    onClick={handleDismiss}
                />
            </div>
            {currentStep === 1 ? (
                <>
                    <p className="py-2 text-xs">
                        {isConfidential ? tWC("body") : tW("body")}
                    </p>
                    <div className="pt-2 flex justify-between items-center">
                        <span className="text-xs text-popover/70">
                            {tW("progress", {
                                current: currentStep,
                                total: 2,
                            })}
                        </span>
                        <Button
                            variant="default"
                            size="sm"
                            className="bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                            onClick={handleNext}
                        >
                            {tW("next")}
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <p className="py-2 text-xs">{tW("body2")}</p>
                    <div className="pt-2 flex justify-between items-center">
                        <span className="text-xs text-popover/70">
                            {tW("progress", {
                                current: currentStep,
                                total: 2,
                            })}
                        </span>
                        <div className="flex gap-1.5">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-popover hover:text-popover/90 hover:bg-transparent!"
                                onClick={handleDismiss}
                            >
                                {tW("noThanks")}
                            </Button>
                            <Button
                                variant="default"
                                size="sm"
                                className="bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                                onClick={handleStartTour}
                            >
                                {tW("letsGo")}
                            </Button>
                        </div>
                    </div>
                </>
            )}
        </div>
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
    const isMobile = useMediaQuery("(max-width: 768px)");
    const isSidebarOpen = useSidebarStore((state) => state.isSidebarOpen);
    const { currentTour } = useNextStep();
    const isTourActive = !!currentTour;
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);

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
    const hidden = isMobile && isSidebarOpen;

    useEffect(() => {
        if (isVisible) {
            pushOverlay();
            return () => popOverlay();
        }
    }, [isVisible]);

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
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-popover-foreground text-popover rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">{tC("heading")}</h1>
                <XIcon
                    className="size-4 cursor-pointer"
                    onClick={handleDismiss}
                />
            </div>
            <p className="py-2 text-xs">{tC("body")}</p>
            <div className="pt-2 flex justify-end">
                <Button
                    variant="default"
                    size="sm"
                    className="bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                    onClick={handleDismiss}
                >
                    {tC("letsGo")}
                </Button>
            </div>
        </div>
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
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);

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

    useEffect(() => {
        if (isVisible) {
            pushOverlay();
            return () => popOverlay();
        }
    }, [isVisible]);

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
        <div className="fixed max-w-72 flex flex-col gap-0 bottom-8 right-8 z-50 p-3 bg-popover-foreground text-popover rounded-[8px]">
            <div className="flex items-center justify-between pt-0.5 pb-2.5">
                <h1 className="text-sm font-semibold">🎉 {tN("title")}</h1>
                <XIcon
                    className="size-4 cursor-pointer"
                    onClick={handleDismiss}
                />
            </div>
            <p className="py-2 text-xs">{tN("body")}</p>
            <div className="pt-2 flex justify-end gap-1.5">
                <Button
                    variant="default"
                    size="sm"
                    className="bg-popover text-popover-foreground hover:bg-popover/90 hover:text-popover-foreground/90"
                    onClick={handleTryIt}
                >
                    {tN("tryIt")}
                </Button>
            </div>
        </div>
    );
}
