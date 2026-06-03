"use client";

import { useTranslations } from "next-intl";
import { TokenDisplay } from "@/components/token-display-with-network";
import { cn } from "@/lib/utils";
import type { TokenReceiptInfo } from "../utils/receipt-models";
import { getTokenDisplayFields } from "../utils/token-display";

interface ReceiptLabelValueRowProps {
    label: string;
    value: React.ReactNode;
    className?: string;
    labelClassName?: string;
    valueClassName?: string;
}

function ReceiptLabelValueRow({
    label,
    value,
    className = "",
    labelClassName = "",
    valueClassName = "",
}: ReceiptLabelValueRowProps) {
    return (
        <div className={cn("flex items-start gap-6 text-sm", className)}>
            <p
                className={cn(
                    "w-60 shrink-0 text-muted-foreground text-sm",
                    labelClassName,
                )}
            >
                {label}
            </p>
            <div className={cn("flex-1 text-left font-medium", valueClassName)}>
                {value}
            </div>
        </div>
    );
}

export function ReceiptSenderSection({
    senderAddress,
    className = "mt-2 border-b pb-3 pt-3",
}: {
    senderAddress: string;
    className?: string;
}) {
    const tReceipt = useTranslations("receiptPage");

    return (
        <section className="space-y-3">
            <div>
                <p className="text-base font-semibold">{tReceipt("sender")}</p>
                <ReceiptLabelValueRow
                    label={tReceipt("address")}
                    value={senderAddress}
                    className={className}
                    valueClassName="break-all"
                />
            </div>
        </section>
    );
}

export function ReceiptTokenAmountRow({
    label,
    metadata,
    amount,
    className = "py-3",
}: {
    label: string;
    metadata: TokenReceiptInfo["metadata"];
    amount: string;
    className?: string;
}) {
    const { symbol, icon } = getTokenDisplayFields(metadata);

    return (
        <ReceiptLabelValueRow
            label={label}
            value={
                <div className="flex items-center justify-start gap-2">
                    <TokenDisplay symbol={symbol} icon={icon} iconSize="lg" />
                    <span>{amount}</span>
                </div>
            }
            className={className}
        />
    );
}
