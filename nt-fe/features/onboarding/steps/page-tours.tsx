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

type PageTourKey = "membersPending" | "requestTemplates";

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
    MEMBERS_PENDING: "members-pending",
    EARN_ANNOUNCEMENT: EARN_ANNOUNCEMENT_TOUR_NAME,
    REQUEST_TEMPLATES: "request-templates",
} as const;

// Fired right after a DAO enables Custom Requests in Settings → Developer, to point at the
// newly revealed sidebar section.
export const REQUEST_TEMPLATES_TOUR_NAME = PAGE_TOUR_NAMES.REQUEST_TEMPLATES;

// Local storage keys
export const PAGE_TOUR_STORAGE_KEYS = {
    MEMBERS_PENDING_SHOWN: "members-pending-tour-shown",
    REQUEST_TEMPLATES_SHOWN: "request-templates-tour-shown",
} as const;

// Selector IDs
export const PAGE_TOUR_SELECTORS = {
    MEMBERS_PENDING_BTN: "#members-pending-btn",
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

const defaultStepProps = {
    icon: null,
    title: "",
    disableInteraction: true,
    showControls: false,
    showSkip: false,
    pointerPadding: 8,
    pointerRadius: 8,
} as const;

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
