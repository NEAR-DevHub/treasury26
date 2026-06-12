import type { Query, QueryClient } from "@tanstack/react-query";
import type { ProposalsResponse } from "@/lib/proposals-api";

// How long after a payment request is created we keep polling for it to show up
// while the backend indexer catches up.
const PAYMENT_PENDING_WINDOW_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000; //5 seconds

function paymentPendingKey(treasuryId: string) {
    return `onboarding:payment-pending:${treasuryId}`;
}

/**
 * Marks that a payment request was just created for a treasury, so onboarding
 * surfaces poll for it until the indexer reflects it.
 */
export function markPaymentPending(
    treasuryId: string,
    queryClient: QueryClient,
) {
    if (typeof window === "undefined") return;
    const hasExistingProposals = queryClient
        .getQueryCache()
        .findAll({ queryKey: ["proposals", treasuryId] })
        .some(
            (query) =>
                ((query.state.data as ProposalsResponse)?.proposals?.length ??
                    0) > 0,
        );
    if (hasExistingProposals) return;
    window.localStorage.setItem(
        paymentPendingKey(treasuryId),
        String(Date.now()),
    );
}

export function clearPaymentPending(treasuryId: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(paymentPendingKey(treasuryId));
}

/**
 * Builds a `refetchInterval` for the onboarding payments query: poll every 5 seconds,
 * but only while a payment was recently created (flag set, within the window)
 * and no payment has appeared yet.
 */
export function buildPaymentPendingRefetchInterval(
    treasuryId: string | null | undefined,
) {
    return (query: Query<ProposalsResponse>): number | false => {
        if ((query.state.data?.proposals?.length ?? 0) > 0) return false;
        if (typeof window === "undefined" || !treasuryId) return false;
        const raw = window.localStorage.getItem(paymentPendingKey(treasuryId));
        const ts = raw ? Number(raw) : 0;
        if (!ts || Date.now() - ts > PAYMENT_PENDING_WINDOW_MS) return false;
        return POLL_INTERVAL_MS;
    };
}
