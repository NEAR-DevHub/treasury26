/**
 * Classify wallet/signing errors: a user declining or closing their wallet is
 * an expected outcome (Info — never reported to Sentry); everything else from
 * a signing flow is a real failure worth reporting.
 */

const REJECTION_PATTERNS =
    /user reject|rejected by user|user cancel|cancelled by user|canceled by user|user denied|user closed|popup closed|window closed|modal closed|user abort|aborted by user|denied by user/i;

export function isUserRejection(error: unknown): boolean {
    if (typeof error === "string") {
        return REJECTION_PATTERNS.test(error);
    }
    if (error instanceof Error) {
        return REJECTION_PATTERNS.test(error.message);
    }
    if (typeof error === "object" && error !== null) {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" && REJECTION_PATTERNS.test(message);
    }
    return false;
}
