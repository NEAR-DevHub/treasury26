import type {
    Proposal,
    SwapStatus,
    SwapStatusResponse,
} from "@/lib/proposals-api";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import type {
    BatchPaymentRequestData,
    ConfidentialBulkData,
    ConfidentialRequestData,
    PaymentRequestData,
    SwapRequestData,
} from "@/features/proposals/types/index";

export interface ReceiptProposalData {
    variant: "payment" | "exchange";
    sourceTokenId?: string;
    destinationTokenId?: string;
    depositAddress?: string;
    receiverAddress?: string;
    sourceAmountRaw?: string;
    destinationAmountWithDecimals?: string;
}

export interface ConfidentialBulkRecipientLeg {
    recipient: string;
    /** Gross amount charged for this leg (quote amountIn). */
    amountIn: string;
    /** Recipient net amount in smallest units (quote amountOut). */
    amountOut: string;
}

/** Receipt/batch payment shape — net amount the recipient receives. */
export interface ConfidentialBulkReceiptPayment {
    recipient: string;
    /** Recipient net amount in smallest units (quote amountOut). */
    amount: string;
}

export interface ConfidentialBulkReceiptData {
    tokenId: string;
    payments: ConfidentialBulkReceiptPayment[];
}

type BulkQuoteMetadata = {
    quote?: {
        amountIn?: string;
        amountOut?: string;
    };
    quoteRequest?: {
        recipient?: string;
    };
};

/**
 * Map a confidential bulk recipient's stored 1Click quote into shared leg
 * fields (recipient + amountIn/amountOut) used by receipts and expanded view.
 */
export function mapConfidentialBulkRecipientPayment(
    quoteMetadata: Record<string, unknown> | null | undefined,
): ConfidentialBulkRecipientLeg {
    const quote = (quoteMetadata ?? {}) as BulkQuoteMetadata;
    const amountIn = quote.quote?.amountIn ?? "0";
    const amountOut = quote.quote?.amountOut ?? amountIn;
    const recipient = quote.quoteRequest?.recipient ?? "";
    return { recipient, amountIn, amountOut };
}

export function toConfidentialBulkReceiptData(
    data: ConfidentialBulkData,
): ConfidentialBulkReceiptData {
    return {
        tokenId: data.tokenId,
        payments: data.recipients.map((recipient) => {
            const leg = mapConfidentialBulkRecipientPayment(
                recipient.quoteMetadata,
            );
            return { recipient: leg.recipient, amount: leg.amountOut };
        }),
    };
}

/**
 * Extract multi-recipient receipt rows for a confidential bulk payment.
 * Returns null for non-bulk confidential requests and other proposal kinds.
 */
export function extractConfidentialBulkReceiptData(
    proposal: Proposal,
    treasuryId?: string,
): ConfidentialBulkReceiptData | null {
    try {
        const { type, data } = extractProposalData(proposal, treasuryId);
        if (type !== "Confidential Request") {
            return null;
        }

        const confidentialData = data as ConfidentialRequestData;
        if (confidentialData.mapped?.type !== "bulk") {
            return null;
        }

        return toConfidentialBulkReceiptData(confidentialData.mapped.data);
    } catch {
        return null;
    }
}

export function isReceiptEligibleProposalKind(proposalKind?: string): boolean {
    return (
        proposalKind === "Payment Request" ||
        proposalKind === "Batch Payment Request" ||
        proposalKind === "Exchange" ||
        proposalKind === "Confidential Request"
    );
}

export function isTerminalSwapStatus(status?: SwapStatus | null): boolean {
    return status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";
}

export function getProposalExecutedDate(
    swapStatus: SwapStatusResponse | null | undefined,
    transaction: { timestamp: number } | null | undefined,
): Date | null {
    if (swapStatus?.updatedAt) {
        return new Date(swapStatus.updatedAt);
    }

    if (transaction?.timestamp) {
        return new Date(transaction.timestamp / 1000000);
    }

    return null;
}

function toPaymentReceiptData(data: PaymentRequestData): ReceiptProposalData {
    return {
        variant: "payment",
        sourceTokenId: data.tokenId,
        destinationTokenId: data.destinationAssetId,
        depositAddress: data.depositAddress,
        receiverAddress: data.receiver,
        sourceAmountRaw: data.amount,
        destinationAmountWithDecimals: undefined,
    };
}

function toExchangeReceiptData(
    data: SwapRequestData,
    treasuryId?: string,
): ReceiptProposalData {
    return {
        variant: "exchange",
        sourceTokenId: data.tokenInAddress || data.tokenIn,
        destinationTokenId: data.tokenOutAddress || data.tokenOut,
        depositAddress: data.depositAddress,
        receiverAddress: treasuryId,
        sourceAmountRaw: data.amountIn,
        destinationAmountWithDecimals: data.amountOut,
    };
}

export function extractReceiptProposalData(
    proposal: Proposal,
    treasuryId?: string,
): ReceiptProposalData | null {
    try {
        const { type, data } = extractProposalData(proposal, treasuryId);

        if (type === "Payment Request") {
            return toPaymentReceiptData(data as PaymentRequestData);
        }

        if (type === "Batch Payment Request") {
            const batchData = data as BatchPaymentRequestData;
            return {
                variant: "payment",
                sourceTokenId: batchData.tokenId,
                destinationTokenId: undefined,
                depositAddress: undefined,
                receiverAddress: undefined,
                sourceAmountRaw: batchData.totalAmount,
                destinationAmountWithDecimals: undefined,
            };
        }

        if (type === "Exchange") {
            return toExchangeReceiptData(data as SwapRequestData, treasuryId);
        }

        if (type === "Confidential Request") {
            const confidentialData = data as ConfidentialRequestData;
            if (confidentialData.mapped?.type === "payment") {
                return toPaymentReceiptData(confidentialData.mapped.data);
            }

            if (confidentialData.mapped?.type === "swap") {
                return toExchangeReceiptData(
                    confidentialData.mapped.data,
                    treasuryId,
                );
            }

            // Bulk receipts render via the multi-card path using
            // extractConfidentialBulkReceiptData — surface token/total here so
            // eligibility checks treat the proposal as receipt-capable.
            if (confidentialData.mapped?.type === "bulk") {
                const bulkData = confidentialData.mapped.data;
                return {
                    variant: "payment",
                    sourceTokenId: bulkData.tokenId,
                    destinationTokenId: undefined,
                    depositAddress: undefined,
                    receiverAddress: undefined,
                    sourceAmountRaw: bulkData.totalAmount,
                    destinationAmountWithDecimals: undefined,
                };
            }
        }
    } catch {
        // Keep fallback values.
    }

    return null;
}
