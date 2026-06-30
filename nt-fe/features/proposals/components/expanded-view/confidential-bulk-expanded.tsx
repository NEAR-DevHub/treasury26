import { ConfidentialBulkData } from "../../types/index";
import { BatchPayment, PaymentStatus } from "@/lib/api";
import { BatchPaymentExpandedView } from "./batch-payment-expanded";
import Big from "@/lib/big";

interface ConfidentialBulkExpandedProps {
    data: ConfidentialBulkData;
}

/**
 * Confidential bulk-payment expanded view. Maps each recipient row from the
 * BE-attached `confidential_metadata.bulk` overlay into the public
 * `BatchPayment` shape so the same pure renderer can show it.
 *
 * Header total + token come from the parent extractor (header quote).
 * Recipient amount/recipient come from each leg's stored 1Click quote.
 *
 * Per-leg fee = `amountIn - minAmountOut` from the stored quote — the actual
 * worst-case withdrawal fee that was committed at prepare time. Summed across
 * recipients and passed as the override so the row reflects what the DAO is
 * really paying, not a fresh SDK estimate.
 */
export function ConfidentialBulkExpanded({
    data,
}: ConfidentialBulkExpandedProps) {
    let totalFeeRaw = Big(0);
    const payments: BatchPayment[] = data.recipients.map((r) => {
        const quote =
            (r.quoteMetadata as
                | {
                      quote?: {
                          amountIn?: string;
                          amountOut?: string;
                      };
                      quoteRequest?: { recipient?: string };
                  }
                | undefined) ?? {};
        const amountIn = quote.quote?.amountIn ?? "0";
        const amountOut = quote.quote?.amountOut ?? amountIn;
        const recipient = quote.quoteRequest?.recipient ?? "";
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
            totalNetworkFeeOverride={
                totalFeeRaw.gt(0) ? totalFeeRaw.toFixed(0) : null
            }
        />
    );
}
