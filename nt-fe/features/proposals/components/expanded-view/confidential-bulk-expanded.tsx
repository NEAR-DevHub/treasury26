import { ConfidentialBulkData } from "../../types/index";
import { BatchPayment, PaymentStatus } from "@/lib/api";
import { BatchPaymentExpandedView } from "./batch-payment-expanded";
import {
    mapConfidentialBulkRecipientPayment,
    sumConfidentialBulkNetworkFee,
} from "../../utils/confidential-bulk-utils";
import { useRequestDisplayContext } from "./common/request-display-context";

interface ConfidentialBulkExpandedProps {
    data: ConfidentialBulkData;
    proposalId: number;
}

/**
 * Confidential bulk-payment expanded view. Maps each recipient row from the
 * BE-attached `confidential_metadata.bulk` overlay into the public
 * `BatchPayment` shape so the same pure renderer can show it.
 *
 * Header total + token come from the parent extractor (header quote).
 * Recipient amount/recipient come from each leg's stored 1Click quote.
 *
 * Per-leg fee = `amountInFormatted - amountOutFormatted` from the stored
 * quote (human-readable token units) — same as Review / single confidential
 * payment. Raw smallest-unit diffs are wrong when origin and destination
 * decimals differ. Summed across recipients and passed as the override so
 * the row reflects what the DAO committed at prepare time.
 */
export function ConfidentialBulkExpanded({
    data,
    proposalId,
}: ConfidentialBulkExpandedProps) {
    const requestDisplayContext = useRequestDisplayContext();
    const isExecuted = requestDisplayContext?.isExecuted ?? false;

    const totalNetworkFee = sumConfidentialBulkNetworkFee(data.recipients);
    const payments: BatchPayment[] = data.recipients.map((r) => {
        const { recipient, amountOut } = mapConfidentialBulkRecipientPayment(
            r.quoteMetadata,
        );
        const isPaid = r.status === "submitted";
        const status: PaymentStatus = isPaid
            ? { Paid: { block_height: 0 } }
            : "Pending";

        return { recipient, amount: amountOut, status };
    });

    return (
        <BatchPaymentExpandedView
            tokenId={data.tokenId}
            totalAmount={data.totalAmount}
            payments={payments}
            notes={data.notes}
            batchId={null}
            proposalId={proposalId}
            showReceiptButton={isExecuted}
            destinationAssetId={data.destinationAssetId}
            totalNetworkFeeOverride={
                totalNetworkFee.gt(0) ? totalNetworkFee.toFixed() : null
            }
        />
    );
}
