import * as Sentry from "@sentry/nextjs";
import { isReportedError, markReportedError } from "@/lib/http";

/**
 * Log and send an error to Sentry. Use for any caught failure we care about
 * in observability. Pair with a user-facing toast when the failure blocks the
 * user's flow and cannot be resolved automatically.
 *
 * Pass `options.code` (a stable error code, e.g. "FE_WALLET_SIGN_FAILED") to
 * tag and fingerprint the event so Sentry groups by code and alert rules can
 * route on `alert_priority`. Errors already reported by the shared http
 * interceptor are skipped, never double-captured.
 */
export function reportError(
    error: unknown,
    context: string,
    options?: { code: string; priority?: "p1" | "p2" },
): void {
    console.error(context, error);
    if (isReportedError(error)) {
        return;
    }
    markReportedError(error);

    if (!options) {
        Sentry.captureException(error, { extra: { context } });
        return;
    }

    Sentry.withScope((scope) => {
        scope.setTag("error_code", options.code);
        scope.setTag("alert_priority", options.priority ?? "p2");
        scope.setFingerprint([options.code]);
        scope.setExtra("context", context);
        Sentry.captureException(error);
    });
}
