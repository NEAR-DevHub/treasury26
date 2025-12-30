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

    let tokenId = data.tokenId;
    if (batchData?.token_id?.toLowerCase() === "native") {
        tokenId = "near";
    }

    const tokenData = {
        tokenId: tokenId,
        amount: data.totalAmount,
        network: "near",
        receiver: recipients
    } as PaymentRequestData;

    return (
        <TokenCell data={tokenData} isUser={false} />
    );
}
