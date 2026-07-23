"use client";

import posthog from "posthog-js";

type AnalyticsParamValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsParamValue>;

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID;
const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

declare global {
    interface Window {
        dataLayer?: Record<string, unknown>[];
        gtag?: (...args: unknown[]) => void;
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

function sendToGoogleAnalytics(
    eventName: string,
    params: AnalyticsParams = {},
) {
    if (!GA_MEASUREMENT_ID || typeof window === "undefined") return;

    window.gtag?.("event", eventName, {
        send_to: GA_MEASUREMENT_ID,
        ...params,
    });
}

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
    posthog.capture(eventName, params);
    pushToDataLayer(eventName, params);
    sendToGoogleAnalytics(eventName, params);
}
