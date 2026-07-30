import * as Sentry from "@sentry/nextjs";

/**
 * Log and send an error to Sentry. Use for any caught failure we care about
 * in observability. Pair with a user-facing toast when the failure blocks the
 * user's flow and cannot be resolved automatically.
 */
export function reportError(error: unknown, context: string): void {
    console.error(context, error);
    Sentry.captureException(error, { extra: { context } });
}
