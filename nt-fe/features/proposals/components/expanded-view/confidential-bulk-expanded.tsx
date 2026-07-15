import { ConfidentialBulkData } from "../../types/index";
import { BatchPayment, PaymentStatus } from "@/lib/api";
import { BatchPaymentExpandedView } from "./batch-payment-expanded";
import Big from "@/lib/big";
import { mapConfidentialBulkRecipientPayment } from "../../utils/receipt-utils";
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
 * Per-leg fee = `amountIn - amountOut` from the stored quote — the actual
 * withdrawal fee committed at prepare time. Summed across recipients and
 * passed as the override so the row reflects what the DAO is really paying,
 * not a fresh SDK estimate.
 */
export function ConfidentialBulkExpanded({
    data,
    proposalId,
}: ConfidentialBulkExpandedProps) {
    const requestDisplayContext = useRequestDisplayContext();
    const isExecuted = requestDisplayContext?.isExecuted ?? false;

    let totalFeeRaw = Big(0);
    const payments: BatchPayment[] = data.recipients.map((r) => {
        const { recipient, amountIn, amountOut } =
            mapConfidentialBulkRecipientPayment(r.quoteMetadata);
        const isPaid = r.status === "submitted";
        const status: PaymentStatus = isPaid
            ? { Paid: { block_height: 0 } }
            : "Pending";

        const legFee = Big(amountIn).minus(amountOut);
        if (legFee.gt(0)) {
            totalFeeRaw = totalFeeRaw.add(legFee);
        }

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
            totalNetworkFeeOverride={
                totalFeeRaw.gt(0) ? totalFeeRaw.toFixed(0) : null
            }
        />
    );
}
