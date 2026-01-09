import { useBatchPayment, useToken } from "@/hooks/use-treasury-queries";
import { BatchPaymentRequestData } from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { BatchPayment, BatchPaymentResponse, TokenMetadata } from "@/lib/api";
import { Button } from "@/components/button";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Address } from "@/components/address";
import { User } from "@/components/user";

interface PaymentDisplayProps {
    number: number;
    payment: BatchPayment;
    expanded: boolean;
    onExpandedClick: () => void;
    tokenId: string;
}

function PaymentDisplay({ number, payment, expanded, onExpandedClick, tokenId }: PaymentDisplayProps) {


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
            <InfoDisplay style="secondary" className="p-3 rounded-b-lg" items={[
                {
                    label: "Recipient",
                    value: <User accountId={payment.recipient} />
                },
                {
                    label: "Amount",
                    value: <Amount amount={payment.amount.toString()} showNetwork tokenId={tokenId} />
                }
            ]} />

        </CollapsibleContent>
    </Collapsible>
}

interface BatchPaymentRequestExpandedProps {
    data: BatchPaymentRequestData;
}

function recipientsDisplay({ batchData, tokenId }: { batchData?: BatchPaymentResponse | null, tokenId: string }): InfoItem {
    const [expanded, setExpanded] = useState<number[]>([]);
    if (!batchData) {
        return {
            label: "Recipients",
            value: <span>Loading...</span>
        };
    }

    const onExpandedChanged = (expanded: number) => {
        setExpanded((prev) => {
            if (prev.includes(expanded)) {
                return prev.filter((id) => id !== expanded);
            }
            return [...prev, expanded];
        })
    }

    const isAllExpanded = expanded.length === batchData?.payments.length;
    const toggleAllExpanded = () => {
        if (isAllExpanded) {
            setExpanded([]);
        } else {
            setExpanded(batchData.payments.map((_, index) => index));
        }
    }

    return {
        label: "Recipients",
        value: <div className="flex gap-3 items-baseline">
            <p className="text-sm font-medium">{batchData.payments.length} recipient{batchData.payments.length > 1 ? "s" : ""}</p>
            <Button variant="ghost" size="sm" onClick={toggleAllExpanded}>{isAllExpanded ? "Collapse all" : "Expand all"}</Button>
        </div>,
        afterValue: <div className="flex flex-col gap-1">
            {batchData.payments.map((payment, index) => (
                <PaymentDisplay tokenId={tokenId} number={index + 1} key={index} payment={payment} expanded={expanded.includes(index)} onExpandedClick={() => onExpandedChanged(index)} />
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
        recipientsDisplay({ batchData, tokenId: tokenId })
    ];

    return (
        <InfoDisplay items={items} />
    );
}
