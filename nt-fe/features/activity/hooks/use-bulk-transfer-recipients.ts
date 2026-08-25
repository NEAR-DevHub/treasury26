"use client";

import { useMemo } from "react";
import { mapConfidentialBulkRecipientPayment } from "@/features/proposals/utils/confidential-bulk-utils";
import { extractBatchPaymentRequestData } from "@/features/proposals/utils/proposal-extractors";
import { useProposal } from "@/hooks/use-proposals";
import { useBatchPayment } from "@/hooks/use-treasury-queries";
import type { PaymentStatus, RecentActivity } from "@/lib/api";
import Big from "@/lib/big";
import { BULK_PAYMENT_CONTRACT_ID } from "@/lib/bulk-payment-api";
import type { Proposal } from "@/lib/proposals-api";
import { formatTokenDisplayAmount } from "@/lib/utils";

/** One payout of a bulk transfer, in the units the dialog renders. */
export interface BulkTransferRecipient {
    accountId: string;
    /** Human-readable, unsigned token amount. */
    amount: string;
    /** Leg value in USD, when the activity's token carries a price. */
    valueUsd: number | null;
    /** Paid legs are the only ones with a payout transaction to link to. */
    isPaid: boolean;
}

export interface BulkTransferDetails {
    /** Bulk payment list id, needed to resolve per-recipient payout hashes. */
    batchId: string | null;
    recipients: BulkTransferRecipient[];
}

/**
 * A treasury pays a batch by transferring the total to the bulk payment
 * contract (or, for confidential treasuries, to its bulk subaccount), which
 * then fans the funds out. That header transfer is what shows up in activity.
 */
export function isBulkTransferActivity(activity: RecentActivity): boolean {
    const recipient = activity.receiverId ?? activity.counterparty;
    if (!recipient) return false;
    return (
        recipient === BULK_PAYMENT_CONTRACT_ID ||
        recipient.endsWith(`.${BULK_PAYMENT_CONTRACT_ID}`)
    );
}

function batchIdOf(proposal: Proposal | null | undefined): string | null {
    if (!proposal) return null;
    try {
        return extractBatchPaymentRequestData(proposal).batchId || null;
    } catch {
        // Not a public batch payment proposal — confidential bulk carries its
        // recipients inline instead.
        return null;
    }
}

function isPaidStatus(status: PaymentStatus): boolean {
    return typeof status !== "string" && "Paid" in status;
}

function toUnits(rawAmount: string, decimals: number): Big | null {
    try {
        return Big(rawAmount).div(Big(10).pow(decimals));
    } catch {
        return null;
    }
}

/**
 * Resolves the recipients behind a bulk transfer's header activity row. The
 * public path goes activity → proposal → batch id → bulk payment contract;
 * confidential bulk carries its legs on the proposal itself.
 */
export function useBulkTransferRecipients(
    activity: RecentActivity,
    treasuryId: string,
): BulkTransferDetails | null {
    const proposalId =
        activity.proposalId != null && isBulkTransferActivity(activity)
            ? String(activity.proposalId)
            : null;
    const { data: proposal } = useProposal(treasuryId, proposalId);
    const batchId = useMemo(() => batchIdOf(proposal), [proposal]);
    const { data: batch } = useBatchPayment(batchId);

    const { decimals, price } = activity.tokenMetadata;

    return useMemo(() => {
        const usdOf = (units: Big | null) =>
            units && price ? units.times(price).toNumber() : null;

        if (batch) {
            return {
                batchId,
                recipients: batch.payments.map((payment) => {
                    const units = toUnits(payment.amount, decimals);
                    return {
                        accountId: payment.recipient,
                        amount: formatTokenDisplayAmount(units ?? "0"),
                        valueUsd: usdOf(units),
                        isPaid: isPaidStatus(payment.status),
                    };
                }),
            };
        }

        const confidentialLegs = proposal?.confidential_metadata?.bulk;
        if (confidentialLegs) {
            return {
                batchId: null,
                recipients: confidentialLegs.recipients.map((leg) => {
                    const { recipient, amountInFormatted } =
                        mapConfidentialBulkRecipientPayment(leg.quote_metadata);
                    let units: Big | null = null;
                    try {
                        units = Big(amountInFormatted || "0");
                    } catch {
                        units = null;
                    }
                    return {
                        accountId: recipient,
                        amount: formatTokenDisplayAmount(units ?? "0"),
                        valueUsd: usdOf(units),
                        isPaid: false,
                    };
                }),
            };
        }

        return null;
    }, [batch, batchId, decimals, price, proposal]);
}
