"use client";

import { useTranslations } from "next-intl";
import { TokenDisplay } from "@/components/token-display-with-network";
import { cn } from "@/lib/utils";
import type { TokenReceiptInfo } from "../utils/receipt-models";
import { getTokenDisplayFields } from "../utils/token-display";

interface ReceiptLabelValueRowProps {
    label: React.ReactNode;
    value: React.ReactNode;
    className?: string;
    labelClassName?: string;
    valueClassName?: string;
}

/**
 * One receipt line: label and value each take half the width, separated by a
 * hairline. The closing section drops its trailing rule via `flushLastRow`.
 */
export function ReceiptLabelValueRow({
    label,
    value,
    className,
    labelClassName,
    valueClassName,
}: ReceiptLabelValueRowProps) {
    return (
        <div
            className={cn(
                "flex items-center gap-4 border-b border-border py-3 text-base leading-[1.2]",
                className,
            )}
        >
            <div
                className={cn(
                    "min-w-0 flex-1 font-medium text-muted-foreground",
                    labelClassName,
                )}
            >
                {label}
            </div>
            <div
                className={cn(
                    "min-w-0 flex-1 text-left font-semibold",
                    valueClassName,
                )}
            >
                {value}
            </div>
        </div>
    );
}

export const receiptSectionRows = "flex flex-col" as const;

export function ReceiptSection({
    title,
    /** The receipt's closing section drops its trailing hairline. */
    flushLastRow = false,
    children,
}: {
    title: React.ReactNode;
    flushLastRow?: boolean;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2">
            <p className="text-base font-semibold leading-[1.2]">{title}</p>
            <div
                className={cn(
                    receiptSectionRows,
                    flushLastRow && "[&>*:last-child]:border-b-0",
                )}
            >
                {children}
            </div>
        </section>
    );
}

export function ReceiptSenderSection({
    senderAddress,
}: {
    senderAddress: string;
}) {
    const tReceipt = useTranslations("receiptPage");

    return (
        <ReceiptSection title={tReceipt("sender")}>
            <ReceiptLabelValueRow
                label={tReceipt("address")}
                value={senderAddress}
                valueClassName="break-all"
            />
        </ReceiptSection>
    );
}

export function ReceiptTokenAmountRow({
    label,
    metadata,
    amount,
}: {
    label: string;
    metadata: TokenReceiptInfo["metadata"];
    amount: string;
}) {
    const { symbol, icon } = getTokenDisplayFields(metadata);

    return (
        <ReceiptLabelValueRow
            label={label}
            value={
                <div className="flex items-center justify-start gap-1.5">
                    <TokenDisplay
                        symbol={symbol}
                        icon={icon}
                        chainIcons={
                            metadata.value?.network?.chainIcons ?? undefined
                        }
                        iconSize="lg"
                    />
                    <span>{amount}</span>
                </div>
            }
        />
    );
}
