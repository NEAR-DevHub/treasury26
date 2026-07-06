import { useTranslations } from "next-intl";
import {
    BatchPaymentRequestData,
    ConfidentialBulkData,
    PaymentRequestData,
} from "@/features/proposals/types/index";
import { useBatchPayment } from "@/hooks/use-treasury-queries";
import { TokenCell } from "./token-cell";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

interface BatchPaymentCellViewProps {
    tokenId: string;
    totalAmount: string;
    recipientCount: number | null;
    timestamp?: string;
    textOnly?: boolean;
}

/**
 * Pure renderer for batch-payment cells. Public + confidential wrappers feed
 * it pre-resolved values.
 */
export function BatchPaymentCellView({
    tokenId,
    totalAmount,
    recipientCount,
    timestamp,
    textOnly = false,
}: BatchPaymentCellViewProps) {
    const t = useTranslations("proposals.expanded");
    const recipients =
        recipientCount != null
            ? t("recipientsCount", { count: recipientCount })
            : t("unknownRecipients");
    const tokenData = {
        tokenId,
        amount: totalAmount,
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
    const { data: batchData, isLoading } = useBatchPayment(data.batchId);

    if (isLoading) {
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-24" />
            </div>
        );
    }

    let tokenId = data.tokenId;
    if (batchData?.tokenId?.toLowerCase() === "native") {
        tokenId = NEAR_NETWORK_ID;
    }

    return (
        <BatchPaymentCellView
            tokenId={tokenId}
            totalAmount={data.totalAmount}
            recipientCount={batchData?.payments?.length ?? null}
            timestamp={timestamp}
            textOnly={textOnly}
        />
    );
}

interface ConfidentialBatchPaymentCellProps {
    data: ConfidentialBulkData;
    timestamp?: string;
    textOnly?: boolean;
}

/**
 * Confidential bulk-payment cell — recipient count + amount come from
 * `confidential_metadata.bulk` (no contract fetch needed).
 */
export function ConfidentialBatchPaymentCell({
    data,
    timestamp,
    textOnly = false,
}: ConfidentialBatchPaymentCellProps) {
    return (
        <BatchPaymentCellView
            tokenId={data.tokenId}
            totalAmount={data.totalAmount}
            recipientCount={data.recipients.length}
            timestamp={timestamp}
            textOnly={textOnly}
        />
    );
}
