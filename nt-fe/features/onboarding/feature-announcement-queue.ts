"use client";

import { useNextStep } from "nextstepjs";
import { useEffect, useState } from "react";
import { create } from "zustand";

export const FEATURE_DEFINITIONS = {
    notifications: {
        storageKey: "notifications-feature-shown",
        version: 1,
    },
} as const;

export type FeatureDefinitionKey = keyof typeof FEATURE_DEFINITIONS;
const WELCOME_DISMISSED_KEY = "welcome-dismissed";
const DASHBOARD_TOUR_COMPLETED_KEY = "dashboard-tour-completed";
const FEATURE_FLAGS_UPDATED_EVENT = "feature-announcement-flags-updated";

type QueueItem = {
    // Stable unique feature key (e.g. "feature-announcement-notifications").
    id: string;
    // Lower number = higher precedence in the queue.
    priority: number;
    // Whether this feature is currently allowed to be shown.
    eligible: boolean;
    // First time the item entered the queue (used as tie-breaker).
    requestedAt: number;
};

type FeatureAnnouncementQueueState = {
    items: Record<string, QueueItem>;
    // The currently granted queue slot (only this feature may render now).
    activeId: string | null;
    // Global suppression window; while active, queue won't grant any slot.
    blockedUntilMs: number;
    // Insert or update a feature entry while preserving first-seen timestamp.
    upsertItem: (item: Omit<QueueItem, "requestedAt">) => void;
    // Completely remove feature from queue registry (e.g. on unmount).
    removeItem: (id: string) => void;
    // Mark current feature as done and optionally pause before next one.
    releaseItem: (id: string, cooldownMs?: number) => void;
    // Pause all feature announcements for duration (navigation/transition guard).
    suppress: (durationMs: number) => void;
    // Re-evaluate queue now (used after suppression timeout).
    wake: () => void;
};

function pickNextItemId(
    items: Record<string, QueueItem>,
    blockedUntilMs: number,
): string | null {
    if (Date.now() < blockedUntilMs) return null;

    const eligibleItems = Object.values(items).filter((item) => item.eligible);
    if (eligibleItems.length === 0) return null;

    eligibleItems.sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return a.requestedAt - b.requestedAt;
    });

    return eligibleItems[0].id;
}

export const useFeatureAnnouncementQueueStore =
    create<FeatureAnnouncementQueueState>()((set) => ({
        items: {},
        activeId: null,
        blockedUntilMs: 0,
        upsertItem: (item) =>
            set((state) => {
                const existing = state.items[item.id];
                const nextItems = {
                    ...state.items,
                    [item.id]: {
                        ...item,
                        requestedAt: existing?.requestedAt ?? Date.now(),
                    },
                };

                let nextActiveId = state.activeId;
                if (nextActiveId && !nextItems[nextActiveId]?.eligible) {
                    nextActiveId = null;
                }
                if (!nextActiveId) {
                    nextActiveId = pickNextItemId(
                        nextItems,
                        state.blockedUntilMs,
                    );
                }

                return {
                    items: nextItems,
                    activeId: nextActiveId,
                };
            }),
        removeItem: (id) =>
            set((state) => {
                const nextItems = { ...state.items };
                delete nextItems[id];

                let nextActiveId =
                    state.activeId === id ? null : state.activeId;
                if (nextActiveId && !nextItems[nextActiveId]?.eligible) {
                    nextActiveId = null;
                }
                if (!nextActiveId) {
                    nextActiveId = pickNextItemId(
                        nextItems,
                        state.blockedUntilMs,
                    );
                }

                return {
                    items: nextItems,
                    activeId: nextActiveId,
                };
            }),
        releaseItem: (id, cooldownMs = 0) =>
            set((state) => {
                const nextBlockedUntilMs =
                    cooldownMs > 0
                        ? Math.max(
                              state.blockedUntilMs,
                              Date.now() + cooldownMs,
                          )
                        : state.blockedUntilMs;

                const nextActiveId =
                    state.activeId === id
                        ? pickNextItemId(state.items, nextBlockedUntilMs)
                        : state.activeId;

                return {
                    activeId: nextActiveId,
                    blockedUntilMs: nextBlockedUntilMs,
                };
            }),
        suppress: (durationMs) =>
            set((state) => {
                const nextBlockedUntilMs = Math.max(
                    state.blockedUntilMs,
                    Date.now() + durationMs,
                );

                return {
                    blockedUntilMs: nextBlockedUntilMs,
                    activeId: pickNextItemId(state.items, nextBlockedUntilMs),
                };
            }),
        wake: () =>
            set((state) => ({
                activeId: pickNextItemId(state.items, state.blockedUntilMs),
            })),
    }));

export function useFeatureAnnouncementQueueSlot({
    id,
    priority,
    eligible,
}: {
    id: string;
    priority: number;
    eligible: boolean;
}) {
    const activeId = useFeatureAnnouncementQueueStore(
        (state) => state.activeId,
    );
    const upsertItem = useFeatureAnnouncementQueueStore(
        (state) => state.upsertItem,
    );
    const removeItem = useFeatureAnnouncementQueueStore(
        (state) => state.removeItem,
    );
    const releaseItem = useFeatureAnnouncementQueueStore(
        (state) => state.releaseItem,
    );
    const wake = useFeatureAnnouncementQueueStore((state) => state.wake);
    const blockedUntilMs = useFeatureAnnouncementQueueStore(
        (state) => state.blockedUntilMs,
    );

    useEffect(() => {
        // Keep queue in sync with this feature's latest eligibility.
        upsertItem({ id, priority, eligible });
    }, [eligible, id, priority, upsertItem]);

    useEffect(() => {
        return () => {
            // Cleanup on unmount so stale entries never block queue selection.
            removeItem(id);
        };
    }, [id, removeItem]);

    useEffect(() => {
        if (blockedUntilMs <= Date.now()) return;
        const timeout = window.setTimeout(
            () => {
                wake();
            },
            blockedUntilMs - Date.now() + 5,
        );
        return () => window.clearTimeout(timeout);
    }, [blockedUntilMs, wake]);

    return {
        // True when this feature is selected to be shown right now.
        isActive: activeId === id && eligible,
        // Signal queue that this feature is done; optional cooldown between features.
        release: (cooldownMs = 0) => releaseItem(id, cooldownMs),
    };
}

export function suppressFeatureAnnouncements(durationMs: number) {
    // Imperative helper for transition-heavy actions (e.g. route push).
    useFeatureAnnouncementQueueStore.getState().suppress(durationMs);
}

export function refreshFeatureAnnouncements(delayMs = 0) {
    // Re-check queue after onboarding state changes.
    if (typeof window === "undefined" || delayMs <= 0) {
        useFeatureAnnouncementQueueStore.getState().wake();
        window.dispatchEvent(new Event(FEATURE_FLAGS_UPDATED_EVENT));
        return;
    }

    window.setTimeout(() => {
        useFeatureAnnouncementQueueStore.getState().wake();
        window.dispatchEvent(new Event(FEATURE_FLAGS_UPDATED_EVENT));
    }, delayMs);
}

function getVersionedStorageKey(storageKey: string, version: number) {
    return `${storageKey}:v${version}`;
}

function isStorageTrue(key: string) {
    return (
        typeof window !== "undefined" && localStorage.getItem(key) === "true"
    );
}

export function getFeatureStorageKey(feature: FeatureDefinitionKey) {
    const config = FEATURE_DEFINITIONS[feature];
    return getVersionedStorageKey(config.storageKey, config.version);
}

export function hasSeenFeature(feature: FeatureDefinitionKey) {
    return isStorageTrue(getFeatureStorageKey(feature));
}

export function markFeatureSeen(feature: FeatureDefinitionKey) {
    if (typeof window === "undefined") return;
    localStorage.setItem(getFeatureStorageKey(feature), "true");
    window.dispatchEvent(new Event(FEATURE_FLAGS_UPDATED_EVENT));
}

function useFeatureFlagsRevision() {
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        const handleFlagsUpdated = () => setRevision((value) => value + 1);
        window.addEventListener(
            FEATURE_FLAGS_UPDATED_EVENT,
            handleFlagsUpdated,
        );
        return () =>
            window.removeEventListener(
                FEATURE_FLAGS_UPDATED_EVENT,
                handleFlagsUpdated,
            );
    }, []);

    return revision;
}

export function useFeatureAnnouncementsUnlocked() {
    const { currentTour } = useNextStep();
    useFeatureFlagsRevision();

    const welcomeDismissed = isStorageTrue(WELCOME_DISMISSED_KEY);
    const dashboardTourCompleted = isStorageTrue(DASHBOARD_TOUR_COMPLETED_KEY);

    return welcomeDismissed && dashboardTourCompleted && !currentTour;
}
