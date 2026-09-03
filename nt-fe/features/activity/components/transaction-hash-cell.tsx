"use client";

import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReceiptSearch } from "@/hooks/use-receipt-search";
import { getTransactionExplorerLink } from "@/lib/blockchain-utils";
import { cn } from "@/lib/utils";

interface TransactionHashCellProps {
    transactionHashes?: string[];
    receiptIds?: string[];
    className?: string;
    chainName?: string | null;
    depositAddress?: string | null;
    isConfidential?: boolean;
    isExchange?: boolean;
}

/**
 * Reusable component for displaying transaction hash with receipt search fallback
 *
 * Displays a clickable transaction hash link with copy functionality.
 * If no transaction hash is provided, attempts to resolve it from receipt ID.
 * Intents-routed rows (carrying a 1Click deposit address) link to the NEAR
 * Intents explorer; otherwise chainName (from token metadata) picks the
 * block explorer for the tx hash.
 */
export function TransactionHashCell({
    transactionHashes,
    receiptIds,
    className = "flex items-center justify-end gap-2",
    chainName,
    depositAddress,
    isConfidential = false,
    isExchange = false,
}: TransactionHashCellProps) {
    const t = useTranslations("transactionHashCell");
    const needsReceiptSearch = !transactionHashes?.length && !depositAddress;
    const { data: transactionFromReceipt, isLoading } = useReceiptSearch(
        needsReceiptSearch ? receiptIds?.[0] : undefined,
    );

    // The intents explorer's /mask/ URL no longer resolves confidential
    // exchanges, so those rows show nothing.
    if (isConfidential && isExchange) return null;

    const transactionHash = transactionHashes?.length
        ? transactionHashes[0]
        : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    if (needsReceiptSearch && isLoading) {
        return <Skeleton className={cn("h-5 w-full", className)} />;
    }

    const displayValue = transactionHash ?? depositAddress;
    if (!displayValue) return null;

    const explorerLink = getTransactionExplorerLink({
        depositAddress,
        isConfidential,
        transactionHash,
        chainName,
    });

    return (
        <div className={className}>
            {explorerLink ? (
                <a
                    href={explorerLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("openInExplorer")}
                    className="text-sm underline"
                >
                    {displayValue.slice(0, 12)}...
                </a>
            ) : null}
            <CopyButton
                text={displayValue}
                toastMessage={t("hashCopied")}
                variant="ghost"
                size="icon-sm"
                tooltipContent={t("copyHash")}
            />
        </div>
    );
}
