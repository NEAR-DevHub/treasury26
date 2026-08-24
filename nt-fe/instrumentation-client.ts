// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
    dsn:
        process.env.NEXT_PUBLIC_SENTRY_DSN ??
        "https://770b93020aaf1120d67ef430ff7fd074@o4510946911715328.ingest.us.sentry.io/4510946913222656",

    // Separates prod / staging / dev events into Sentry environments so alert
    // rules only fire for production.
    environment:
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

    tracesSampleRate: 0.1,

    // Attach sentry-trace/baggage to backend API requests so a frontend event
    // and its backend handler share a trace.
    tracePropagationTargets: process.env.NEXT_PUBLIC_BACKEND_API_BASE
        ? [process.env.NEXT_PUBLIC_BACKEND_API_BASE]
        : [],

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Disable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

import posthog from "posthog-js";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    api_host: "/_telemetry",
    ui_host: "https://us.posthog.com",
    flags_api_host: "/_features",
    defaults: "2026-01-30",
    // Sentry is the error-reporting system; capturing exceptions here too
    // produced duplicate, unrouted copies of every client error.
    capture_exceptions: false,
    // We use custom onboarding questionnaire UI; disable PostHog survey runtime.
    disable_surveys: true,
    debug: process.env.NODE_ENV === "development",
});
