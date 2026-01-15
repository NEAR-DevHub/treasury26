import { useBatchPayment } from "@/hooks/use-treasury-queries";
import { useBulkPaymentTransactionHash } from "@/hooks/use-bulk-payment-transactions";
import { BatchPaymentRequestData } from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { BatchPayment, BatchPaymentResponse, PaymentStatus } from "@/lib/api";
import { Button } from "@/components/button";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ArrowUpRight, ChevronDown, } from "lucide-react";
import { cn } from "@/lib/utils";
import { Address } from "@/components/address";
import { User } from "@/components/user";
import Link from "next/link";
import { ProposalStatusPill } from "../proposal-status-pill";

interface PaymentDisplayProps {
    number: number;
    payment: BatchPayment;
    expanded: boolean;
    onExpandedClick: () => void;
    tokenId: string;
    batchId: string;
}

const paymentStatusToText = (status: PaymentStatus): string => {
    if (typeof status === "string") {
        return status;
    }
    return Object.keys(status)[0];
}

function PaymentDisplay({ number, payment, expanded, onExpandedClick, tokenId, batchId }: PaymentDisplayProps) {
    const status = paymentStatusToText(payment.status);
    const isPaid = status === "Paid";
    const { data: txData } = useBulkPaymentTransactionHash(
        isPaid ? batchId : null,
        isPaid ? payment.recipient : null
    );
    const transactionHash = txData?.transaction_hash;
    const nearBlocksUrl = transactionHash ? `https://nearblocks.io/txns/${transactionHash}` : null;

    let items: InfoItem[] = [
        {
            label: "Recipient",
            value: <User accountId={payment.recipient} />
        },
        {
            label: "Amount",
            value: <Amount amount={payment.amount.toString()} showNetwork tokenId={tokenId} />
        },
    ];

    if (status !== "Pending") {
        items.push({
            label: "Status",
            value: <ProposalStatusPill status={status} />
        });
    }

    if (isPaid && nearBlocksUrl && nearBlocksUrl.length > 0) {
        items.push({
            label: "Transaction Link",
            value: <Link className="flex items-center gap-2" href={nearBlocksUrl} target="_blank" rel="noopener noreferrer">
                View Transaction <ArrowUpRight className="size-4" />
            </Link>
        });
    }

    return <Collapsible open={expanded} onOpenChange={onExpandedClick}>
        <CollapsibleTrigger className={cn("w-full flex justify-between items-center p-3 border rounded-lg", expanded && "rounded-b-none")}>
            <div className="flex gap-2 items-center">
                <ChevronDown className={cn("w-4 h-4", expanded && "rotate-180")} />
                Recipient {number}
            </div>
            <div className="flex gap-3 items-baseline text-sm text-muted-foreground">
                <Address address={payment.recipient} />
                <Amount amount={payment.amount.toString()} textOnly showNetwork tokenId={tokenId} showUSDValue={false} />
            </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
            <InfoDisplay style="secondary" className="p-3 rounded-b-lg" items={items} />
        </CollapsibleContent>
    </Collapsible>
}

interface BatchPaymentRequestExpandedProps {
    data: BatchPaymentRequestData;
}

function recipientsDisplay({ batchData, tokenId, batchId }: { batchData?: BatchPaymentResponse | null, tokenId: string, batchId: string }): InfoItem {
    const [expanded, setExpanded] = useState<number[]>([]);
    if (!batchData) {
        return {
            label: "Recipients",
            value: <span>Loading...</span>
        };
    }

    const onExpandedChanged = (index: number) => {
        setExpanded((prev) => {
            if (prev.includes(index)) {
                return prev.filter((id) => id !== index);
            }
            return [...prev, index];
        });
    };

    const isAllExpanded = expanded.length === batchData?.payments.length;
    const toggleAllExpanded = () => {
        if (isAllExpanded) {
            setExpanded([]);
        } else {
            setExpanded(batchData.payments.map((_, index) => index));
        }
    };

    return {
        label: "Recipients",
        value: <div className="flex gap-3 items-baseline">
            <p className="text-sm font-medium">{batchData.payments.length} recipient{batchData.payments.length > 1 ? "s" : ""}</p>
            <Button variant="ghost" size="sm" onClick={toggleAllExpanded}>{isAllExpanded ? "Collapse all" : "Expand all"}</Button>
        </div>,
        afterValue: <div className="flex flex-col gap-1">
            {batchData.payments.map((payment, index) => (
                <PaymentDisplay
                    tokenId={tokenId}
                    number={index + 1}
                    key={index}
                    payment={payment}
                    expanded={expanded.includes(index)}
                    onExpandedClick={() => onExpandedChanged(index)}
                    batchId={batchId}
                />
            ))}
        </div>
    };
}

export function BatchPaymentRequestExpanded({ data }: BatchPaymentRequestExpandedProps) {
    const { data: batchData } = useBatchPayment(data.batchId);

    let tokenId = data.tokenId;
    if (batchData?.token_id?.toLowerCase() === "native") {
        tokenId = "near";
    }

    const items: InfoItem[] = [
        {
            label: "Total Amount",
            value: <Amount showNetwork amount={data.totalAmount} tokenId={tokenId} />
        },
        recipientsDisplay({ batchData, tokenId, batchId: data.batchId })
    ];

    return (
        <InfoDisplay items={items} />
    );
}
