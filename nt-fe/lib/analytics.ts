"use client";

import posthog from "posthog-js";

type AnalyticsParamValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsParamValue>;

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID;

declare global {
    interface Window {
        dataLayer?: Record<string, unknown>[];
    }
}

function pushToDataLayer(eventName: string, params: AnalyticsParams = {}) {
    if (!GTM_ID || typeof window === "undefined") return;

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
        event: eventName,
        ...params,
    });
}

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
    posthog.capture(eventName, params);
    pushToDataLayer(eventName, params);
}
