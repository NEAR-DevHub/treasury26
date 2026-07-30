import Big from "@/lib/big";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";

type BulkQuoteMetadata = {
    quote?: {
        amountIn?: string;
        amountInFormatted?: string;
        amountOut?: string;
        amountOutFormatted?: string;
    };
    quoteRequest?: {
        recipient?: string;
        destinationAsset?: string;
        recipientType?: string;
    };
};

export interface ConfidentialBulkRecipientLeg {
    recipient: string;
    /** Gross amount charged for this leg (quote amountIn, smallest units). */
    amountIn: string;
    /** Recipient net amount in smallest units (quote amountOut). */
    amountOut: string;
    /** Gross amount charged for this leg, human-readable token units. */
    amountInFormatted: string;
    /** Recipient net amount, human-readable token units. */
    amountOutFormatted: string;
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
    const amountInFormatted = quote.quote?.amountInFormatted ?? "0";
    const amountOutFormatted =
        quote.quote?.amountOutFormatted ?? amountInFormatted;
    const recipient = quote.quoteRequest?.recipient ?? "";
    return {
        recipient,
        amountIn,
        amountOut,
        amountInFormatted,
        amountOutFormatted,
    };
}

/**
 * Sum per-recipient network fees from stored 1Click quotes, in human-readable
 * token units. Diffs `*Formatted` amounts (not raw smallest units) so origin
 * and destination chain decimals cannot skew the fee — same approach as the
 * Review-step `deriveQuoteFees` and single-payment `computeQuoteNetworkFee`.
 */
export function sumConfidentialBulkNetworkFee(
    recipients: Array<{
        quoteMetadata?: Record<string, unknown> | null;
    }>,
): Big {
    let total = Big(0);
    for (const recipient of recipients) {
        const { amountInFormatted, amountOutFormatted } =
            mapConfidentialBulkRecipientPayment(recipient.quoteMetadata);
        try {
            const legFee = Big(amountInFormatted || "0").minus(
                Big(amountOutFormatted || "0"),
            );
            if (legFee.gt(0)) {
                total = total.add(legFee);
            }
        } catch {
            // Ignore malformed quote amounts for a single leg.
        }
    }
    return total;
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
