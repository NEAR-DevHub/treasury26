// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-scrub";

Sentry.init({
    dsn:
        process.env.NEXT_PUBLIC_SENTRY_DSN ??
        "https://770b93020aaf1120d67ef430ff7fd074@o4510946911715328.ingest.us.sentry.io/4510946913222656",

    environment:
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

    tracesSampleRate: 0.1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Never attach request headers/cookies/IPs — matches the backend's
    // redaction stance.
    sendDefaultPii: false,

    beforeSend: scrubSentryEvent,
});
