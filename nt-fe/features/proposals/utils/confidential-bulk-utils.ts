import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";

type BulkQuoteMetadata = {
    quote?: {
        amountIn?: string;
        amountOut?: string;
    };
    quoteRequest?: {
        recipient?: string;
        destinationAsset?: string;
        recipientType?: string;
    };
};

export interface ConfidentialBulkRecipientLeg {
    recipient: string;
    /** Gross amount charged for this leg (quote amountIn). */
    amountIn: string;
    /** Recipient net amount in smallest units (quote amountOut). */
    amountOut: string;
}

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

/**
 * Receive-network id for a confidential bulk payment — taken from the first
 * recipient leg's quoteRequest (all legs share one destination). Mirrors
 * single confidential payment mapping (`near.com` vs bridge asset id).
 */
export function extractConfidentialBulkDestinationAssetId(
    recipients: Array<{
        quoteMetadata?: Record<string, unknown> | null;
    }>,
): string | undefined {
    for (const recipient of recipients) {
        const quoteRequest = (
            recipient.quoteMetadata as BulkQuoteMetadata | null | undefined
        )?.quoteRequest;
        if (!quoteRequest) continue;
        if (quoteRequest.recipientType === "CONFIDENTIAL_INTENTS") {
            return NEAR_COM_NETWORK_ID;
        }
        if (quoteRequest.destinationAsset) {
            return quoteRequest.destinationAsset;
        }
    }
    return undefined;
}
