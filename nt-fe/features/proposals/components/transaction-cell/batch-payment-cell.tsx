import { useTranslations } from "next-intl";
import {
    BatchPaymentRequestData,
    PaymentRequestData,
} from "@/features/proposals/types/index";
import { useBatchPayment } from "@/hooks/use-treasury-queries";
import { TokenCell } from "./token-cell";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

interface BatchPaymentCellProps {
    data: BatchPaymentRequestData;
    timestamp?: string;
    textOnly?: boolean;
}

export function BatchPaymentCell({
    data,
    timestamp,
    textOnly = false,
}: BatchPaymentCellProps) {
    const t = useTranslations("proposals.expanded");
    const { data: batchData, isLoading } = useBatchPayment(data.batchId);

    // Loading state
    if (isLoading) {
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-24" />
            </div>
        );
    }

    const recipients = batchData?.payments
        ? t("recipientsCount", { count: batchData.payments.length })
        : t("unknownRecipients");

    let tokenId = data.tokenId;
    if (batchData?.tokenId?.toLowerCase() === "native") {
        tokenId = NEAR_NETWORK_ID;
    }

    const tokenData = {
        tokenId: tokenId,
        amount: data.totalAmount,
        receiver: recipients,
    } as PaymentRequestData;

    return (
        <TokenCell
            data={tokenData}
            isUser={false}
            timestamp={timestamp}
            textOnly={textOnly}
        />
    );
}
