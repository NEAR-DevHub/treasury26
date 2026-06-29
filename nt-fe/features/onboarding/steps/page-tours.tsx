"use client";

import { useTranslations } from "next-intl";
import type { Tour } from "nextstepjs";
import { useNextStep } from "nextstepjs";
import { useCallback, useEffect, useRef } from "react";
import {
    EARN_ANNOUNCEMENT_TOUR_NAME,
    FEATURE_DEFINITIONS,
    hasSeenFeature,
    useFeatureAnnouncementQueueSlot,
    useFeatureAnnouncementsUnlocked,
} from "@/features/onboarding/feature-announcement-queue";
import { useTreasury } from "@/hooks/use-treasury";
import { useResponsiveSidebar } from "@/stores/sidebar-store";

type PageTourKey =
    | "paymentsBulk"
    | "paymentsPending"
    | "exchangeSettings"
    | "membersPending"
    | "guestSaveIntro"
    | "guestSaveAction"
    | "requestTemplates";

function PageTourContent({ k }: { k: PageTourKey }) {
    const t = useTranslations("pageTours");
    return <>{t(k)}</>;
}

function PageTourContentRich({ k }: { k: "newFeature" }) {
    const t = useTranslations("pageTours");
    return <>{t(`${k}Rich`)}</>;
}

// Tour names
export const PAGE_TOUR_NAMES = {
    PAYMENTS_BULK: "payments-bulk",
    PAYMENTS_PENDING: "payments-pending",
    EXCHANGE_SETTINGS: "exchange-settings",
    MEMBERS_PENDING: "members-pending",
    GUEST_SAVE: "guest-save",
    EARN_ANNOUNCEMENT: EARN_ANNOUNCEMENT_TOUR_NAME,
    REQUEST_TEMPLATES: "request-templates",
} as const;

// Fired right after a DAO enables Custom Requests in Settings → Developer, to point at the
// newly revealed sidebar section.
export const REQUEST_TEMPLATES_TOUR_NAME = PAGE_TOUR_NAMES.REQUEST_TEMPLATES;

// Local storage keys
export const PAGE_TOUR_STORAGE_KEYS = {
    PAYMENTS_BULK_SHOWN: "payments-bulk-tour-shown",
    PAYMENTS_PENDING_SHOWN: "payments-pending-tour-shown",
    EXCHANGE_SETTINGS_SHOWN: "exchange-settings-tour-shown",
    MEMBERS_PENDING_SHOWN: "members-pending-tour-shown",
    GUEST_SAVE_SHOWN: "guest-save-tour-shown",
    REQUEST_TEMPLATES_SHOWN: "request-templates-tour-shown",
} as const;

// Selector IDs
export const PAGE_TOUR_SELECTORS = {
    PAYMENTS_BULK_BTN: "#payments-bulk-btn",
    PAYMENTS_PENDING_BTN: "#payments-pending-btn",
    EXCHANGE_SETTINGS_BTN: "#exchange-settings-btn",
    MEMBERS_PENDING_BTN: "#members-pending-btn",
    GUEST_BADGE: "#guest-badge",
    GUEST_SAVE_BTN: "#guest-save-btn",
    REQUEST_TEMPLATES_NAV: "#request-templates-nav",
} as const;

export const EARN_ANNOUNCEMENT = {
    tourName: EARN_ANNOUNCEMENT_TOUR_NAME,
    selector: "#earn-new",
    ctaLabelKey: "newFeatureCta" as const,
    href: (treasuryId?: string | null) =>
        treasuryId ? `/${treasuryId}/earn` : "/earn",
    content: <PageTourContentRich k="newFeature" />,
} as const;

export const PAYMENTS_BULK_ANNOUNCEMENT = {
    tourName: PAGE_TOUR_NAMES.PAYMENTS_BULK,
    ctaLabelKey: "newFeatureCta" as const,
    href: (treasuryId?: string | null) =>
        treasuryId
            ? `/${treasuryId}/payments/bulk-payment`
            : "/payments/bulk-payment",
} as const;

export const PAYMENTS_PENDING_ANNOUNCEMENT = {
    tourName: PAGE_TOUR_NAMES.PAYMENTS_PENDING,
    ctaLabelKey: "newFeatureCta" as const,
    href: (treasuryId?: string | null) =>
        treasuryId
            ? `/${treasuryId}/requests?tab=InProgress`
            : "/requests?tab=InProgress",
} as const;

const defaultStepProps = {
    icon: null,
    title: "",
    disableInteraction: true,
    showControls: false,
    showSkip: false,
    pointerPadding: 8,
    pointerRadius: 8,
} as const;

export const PAYMENTS_BULK_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.PAYMENTS_BULK,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="paymentsBulk" />,
            selector: PAGE_TOUR_SELECTORS.PAYMENTS_BULK_BTN,
            side: "bottom",
        },
    ],
};

export const PAYMENTS_PENDING_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.PAYMENTS_PENDING,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="paymentsPending" />,
            selector: PAGE_TOUR_SELECTORS.PAYMENTS_PENDING_BTN,
            side: "bottom-right",
        },
    ],
};

export const EXCHANGE_SETTINGS_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.EXCHANGE_SETTINGS,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="exchangeSettings" />,
            selector: PAGE_TOUR_SELECTORS.EXCHANGE_SETTINGS_BTN,
            side: "bottom-right",
        },
    ],
};

export const MEMBERS_PENDING_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.MEMBERS_PENDING,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="membersPending" />,
            selector: PAGE_TOUR_SELECTORS.MEMBERS_PENDING_BTN,
            side: "bottom-right",
        },
    ],
};

export const GUEST_SAVE_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.GUEST_SAVE,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="guestSaveIntro" />,
            selector: PAGE_TOUR_SELECTORS.GUEST_BADGE,
            side: "right",
        },
        {
            ...defaultStepProps,
            content: <PageTourContent k="guestSaveAction" />,
            selector: PAGE_TOUR_SELECTORS.GUEST_SAVE_BTN,
            side: "right",
        },
    ],
};

export const NEW_FEATURE_TOUR: Tour = {
    tour: EARN_ANNOUNCEMENT.tourName,
    steps: [
        {
            ...defaultStepProps,
            content: EARN_ANNOUNCEMENT.content,
            selector: EARN_ANNOUNCEMENT.selector,
            side: "right",
        },
    ],
};

export const REQUEST_TEMPLATES_TOUR: Tour = {
    tour: PAGE_TOUR_NAMES.REQUEST_TEMPLATES,
    steps: [
        {
            ...defaultStepProps,
            content: <PageTourContent k="requestTemplates" />,
            selector: PAGE_TOUR_SELECTORS.REQUEST_TEMPLATES_NAV,
            side: "right",
        },
    ],
};

function getVersionedStorageKey(storageKey: string, version = 1) {
    return `${storageKey}:v${version}`;
}

/**
 * Hook to trigger the guest save tour when a connected user views a guest treasury for the first time.
 */
export function useGuestSaveTour(
    accountId: string | undefined,
    isSaved: boolean,
) {
    const { startNextStep, currentTour } = useNextStep();
    const { isGuestTreasury, isLoading } = useTreasury();
    const { isSidebarOpen } = useResponsiveSidebar();
    const hasTriggered = useRef(false);

    useEffect(() => {
        if (isLoading || !isGuestTreasury || !accountId || isSaved) return;
        if (currentTour) return;
        if (!isSidebarOpen) return;

        const alreadyShown =
            localStorage.getItem(PAGE_TOUR_STORAGE_KEYS.GUEST_SAVE_SHOWN) ===
            "true";
        if (alreadyShown) return;

        if (hasTriggered.current) return;
        hasTriggered.current = true;

        const timeout = setTimeout(() => {
            localStorage.setItem(
                PAGE_TOUR_STORAGE_KEYS.GUEST_SAVE_SHOWN,
                "true",
            );
            startNextStep(PAGE_TOUR_NAMES.GUEST_SAVE);
        }, 500);

        return () => clearTimeout(timeout);
    }, [
        isLoading,
        isGuestTreasury,
        accountId,
        isSaved,
        currentTour,
        startNextStep,
        isSidebarOpen,
    ]);
}

/**
 * Hook to trigger a one-time page tour on mount.
 * Checks localStorage and guest status before showing.
 */
export function usePageTour(
    tourName: string,
    storageKey: string,
    options?: {
        version?: number;
        enabled?: boolean;
        delay?: number;
    },
) {
    const { startNextStep, currentTour } = useNextStep();
    const { isGuestTreasury, isLoading } = useTreasury();
    const hasTriggered = useRef(false);
    const version = options?.version ?? 1;
    const enabled = options?.enabled ?? true;
    const delay = options?.delay ?? 500;
    const versionedStorageKey = getVersionedStorageKey(storageKey, version);

    useEffect(() => {
        hasTriggered.current = false;
    }, [versionedStorageKey]);

    const triggerTour = useCallback(() => {
        if (hasTriggered.current) return;
        if (currentTour || !enabled) return;

        const alreadyShown =
            localStorage.getItem(versionedStorageKey) === "true";
        if (alreadyShown) return;

        hasTriggered.current = true;
        localStorage.setItem(versionedStorageKey, "true");
        startNextStep(tourName);
    }, [currentTour, enabled, versionedStorageKey, tourName, startNextStep]);

    // Auto-trigger on mount (with delay for DOM readiness)
    useEffect(() => {
        if (isGuestTreasury || isLoading || !enabled || currentTour) return;

        const alreadyShown =
            localStorage.getItem(versionedStorageKey) === "true";
        if (alreadyShown) return;

        const timeout = setTimeout(() => {
            triggerTour();
        }, delay);

        return () => clearTimeout(timeout);
    }, [
        currentTour,
        delay,
        enabled,
        isGuestTreasury,
        isLoading,
        triggerTour,
        versionedStorageKey,
    ]);

    // Return triggerTour for manual triggering (e.g., after form submit)
    return { triggerTour };
}

export function useNewFeatureTour(enabled = true) {
    const { currentTour } = useNextStep();
    const hadActiveNewFeatureTour = useRef(false);
    const featuresUnlocked = useFeatureAnnouncementsUnlocked();
    const alreadySeen = hasSeenFeature("earn");

    const queueSlot = useFeatureAnnouncementQueueSlot({
        id: "feature-announcement-earn",
        priority: 1,
        eligible: enabled && featuresUnlocked && !alreadySeen,
    });
    const releaseQueueSlot = queueSlot.release;

    const pageTour = usePageTour(
        EARN_ANNOUNCEMENT.tourName,
        FEATURE_DEFINITIONS.earn.storageKey,
        {
            version: FEATURE_DEFINITIONS.earn.version,
            enabled: enabled && queueSlot.isActive,
        },
    );

    useEffect(() => {
        if (currentTour === EARN_ANNOUNCEMENT.tourName) {
            hadActiveNewFeatureTour.current = true;
            return;
        }

        if (!hadActiveNewFeatureTour.current) return;
        hadActiveNewFeatureTour.current = false;
        // Keep a short cooldown to avoid lower-priority announcement flash
        // while route transitions (e.g. clicking "Try It" for Earn).
        releaseQueueSlot(2000);
    }, [currentTour, releaseQueueSlot]);

    return pageTour;
}

/**
 * Hook for tours that should only trigger manually (not on mount).
 * Used for the payments pending tour which triggers after form submission.
 */
export function useManualPageTour(tourName: string, storageKey: string) {
    const { startNextStep } = useNextStep();
    const { isGuestTreasury } = useTreasury();

    const triggerTour = useCallback(() => {
        if (isGuestTreasury) return;

        const alreadyShown = localStorage.getItem(storageKey) === "true";
        if (alreadyShown) return;

        localStorage.setItem(storageKey, "true");
        // Delay to let DOM update after form reset
        setTimeout(() => {
            startNextStep(tourName);
        }, 500);
    }, [isGuestTreasury, storageKey, tourName, startNextStep]);

    return { triggerTour };
}
