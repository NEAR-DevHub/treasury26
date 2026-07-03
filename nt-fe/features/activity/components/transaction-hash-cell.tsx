"use client";

import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/button";
import { ExternalLink } from "lucide-react";
import { useReceiptSearch } from "@/hooks/use-receipt-search";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getExplorerTxUrl } from "@/lib/blockchain-utils";

interface TransactionHashCellProps {
    transactionHashes?: string[];
    receiptIds?: string[];
    className?: string;
    chainName?: string | null;
}

/**
 * Reusable component for displaying transaction hash with receipt search fallback
 *
 * Displays a clickable transaction hash link with copy functionality.
 * If no transaction hash is provided, attempts to resolve it from receipt ID.
 * When chainName (from token metadata) is provided, it's used to pick the right
 * block explorer for the tx hash.
 */
export function TransactionHashCell({
    transactionHashes,
    receiptIds,
    className = "flex items-center justify-end gap-2",
    chainName,
}: TransactionHashCellProps) {
    const t = useTranslations("transactionHashCell");
    const needsReceiptSearch = !transactionHashes?.length;
    const { data: transactionFromReceipt, isLoading } = useReceiptSearch(
        needsReceiptSearch ? receiptIds?.[0] : undefined,
    );

    const transactionHash = transactionHashes?.length
        ? transactionHashes[0]
        : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    if (needsReceiptSearch && isLoading) {
        return <Skeleton className={cn("h-5 w-full", className)} />;
    }

    if (!transactionHash) return null;

    const explorerUrl = getExplorerTxUrl(chainName, transactionHash);

    return (
        <div className={className}>
            <div className="text-sm">{transactionHash.slice(0, 12)}...</div>
            {explorerUrl ? (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltipContent={t("openInExplorer")}
                    onClick={() => window.open(explorerUrl, "_blank")}
                >
                    <ExternalLink className="h-3 w-3" />
                </Button>
            ) : null}
            <CopyButton
                text={transactionHash}
                toastMessage={t("hashCopied")}
                variant="ghost"
                size="icon-sm"
                tooltipContent={t("copyHash")}
            />
        </div>
    );
}
