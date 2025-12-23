import { BatchPaymentRequestData, PaymentRequestData } from "@/features/proposals/types/index";
import { useBatchPayment } from "@/hooks/use-treasury-queries";
import { TokenCell } from "./token-cell";

interface BatchPaymentCellProps {
    data: BatchPaymentRequestData;
}

export function BatchPaymentCell({ data }: BatchPaymentCellProps) {
    const { data: batchData } = useBatchPayment(data.batchId);

    const recipients = batchData?.payments ?
        `${batchData.payments.length} recipient${batchData.payments.length > 1 ? "s" : ""}`
        : "Loading...";

    const tokenData = {
        tokenId: data.tokenId,
        amount: data.totalAmount,
        network: "NEAR",
        receiver: recipients
    } as PaymentRequestData;

    return (
        <TokenCell data={tokenData} isUser={false} />
    );
}
