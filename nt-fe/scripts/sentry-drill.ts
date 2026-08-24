/**
 * Alerting drill: fire every frontend error code through the real reporting
 * modules (lib/http interceptor, lib/report-error, sentry-scrub beforeSend)
 * so Sentry -> Discord alert rules can be verified end to end.
 *
 * Usage: cd nt-fe && SENTRY_DSN=... bun run scripts/sentry-drill.ts
 *
 * Expected in Discord: FE_WALLET_SIGN_FAILED (p1) only.
 * Expected in Sentry ONLY: FE_API_FAILED, FE_QUERY_FAILED,
 * FE_MUTATION_FAILED, FE_WALLET_AUTH_FAILED (all p2), untagged scrub-check.
 * Expected NOWHERE: the 404 response and the user-rejection error.
 */
import * as Sentry from "@sentry/nextjs";
import http from "node:http";
import { http as api } from "../lib/http";
import { reportError } from "../lib/report-error";
import { scrubSentryEvent } from "../lib/sentry-scrub";
import { isUserRejection } from "../lib/wallet-errors";

const dsn = process.env.SENTRY_DSN;
if (!dsn) {
    console.error("SENTRY_DSN is required");
    process.exit(1);
}

Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
});

// Mirrors query-provider.tsx reportUnhandled (a client component, so its
// tag/fingerprint shape is replicated here instead of imported).
function fireQueryError(
    errorCode: "FE_QUERY_FAILED" | "FE_MUTATION_FAILED",
    key: string,
) {
    Sentry.withScope((scope) => {
        scope.setTag("error_code", errorCode);
        scope.setTag("alert_priority", "p2");
        scope.setTag("operation", key);
        scope.setFingerprint([errorCode, key]);
        Sentry.captureException(
            new Error(`[DRILL] unhandled ${errorCode} in ${key}`),
        );
    });
}

async function main() {
    const server = http.createServer((req, res) => {
        res.statusCode = req.url?.includes("drill-500") ? 500 : 404;
        res.end("drill");
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    // FE_API_FAILED p2 via the real axios interceptor (5xx reported).
    await api.get(`${base}/api/drill-500`).catch(() => {});
    // Network error variant (http_status=network, separate fingerprint).
    await api.get("http://127.0.0.1:9/drill-network").catch(() => {});
    // NEGATIVE: 4xx must NOT be reported.
    await api.get(`${base}/api/drill-404`).catch(() => {});

    // FE_WALLET_SIGN_FAILED p1 -> the one FE event that must page Discord.
    reportError(
        new Error("[DRILL] Couldn't parse the correct arguments for signing"),
        "wallet signing",
        { code: "FE_WALLET_SIGN_FAILED", priority: "p1" },
    );
    // FE_WALLET_AUTH_FAILED defaults to p2 (Sentry only).
    reportError(new Error("[DRILL] wallet auth failed"), "Authentication failed", {
        code: "FE_WALLET_AUTH_FAILED",
    });

    fireQueryError("FE_QUERY_FAILED", "drill-query");
    fireQueryError("FE_MUTATION_FAILED", "drill-mutation");

    // NEGATIVE: user rejection is an expected outcome, never reported.
    const rejection = new Error("User rejected the request");
    if (isUserRejection(rejection)) {
        console.log("rejection correctly suppressed (not sent)");
    } else {
        reportError(rejection, "BUG: rejection was not suppressed");
    }

    // Untagged noise + scrub check: must reach Sentry (inbox only, no
    // Discord) with the token and JWT shown as [REDACTED].
    Sentry.captureMessage(
        "[DRILL] untagged FE error; scrub check accessToken=super-secret jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkcmlsbCJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1Njc4OTA",
        "error",
    );

    await Sentry.flush(8000);
    server.close();
    console.log(
        "drill complete: 7 events sent (6 issues); 404 + rejection suppressed",
    );
}

main().catch((error) => {
    console.error("drill failed", error);
    process.exit(1);
});
